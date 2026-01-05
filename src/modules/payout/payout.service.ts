import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import {
  Payout,
  PayoutStatus,
} from '../../database/schemas/payout/payout.schema';
import {
  PayoutLog,
  PayoutLogLevel,
  PayoutLogAction,
} from '../../database/schemas/payout/payout-log.schema';
import { User } from '../../database/schemas/user/user.schema';
import { Wallet } from '../../database/schemas/wallet/wallet.schema';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from '../../database/schemas/transaction/transaction.schema';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';

const MINIMUM_PAYOUT_AMOUNT = 20; // £20 minimum

export interface PayoutResult {
  success: boolean;
  payout: Payout;
  message: string;
}

export interface PayoutStats {
  totalPayouts: number;
  totalAmount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectModel(Payout.name) private payoutModel: Model<Payout>,
    @InjectModel(PayoutLog.name) private payoutLogModel: Model<PayoutLog>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Wallet.name) private walletModel: Model<Wallet>,
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
    @InjectQueue('payouts') private payoutQueue: Queue,
    private stripeConnectService: StripeConnectService,
  ) {}

  /**
   * Log payout activity with comprehensive details
   */
  private async log(
    payoutId: Types.ObjectId,
    userId: Types.ObjectId,
    level: PayoutLogLevel,
    action: PayoutLogAction,
    message: string,
    data?: {
      data?: Record<string, any>;
      errorCode?: string;
      errorMessage?: string;
      errorStack?: Record<string, any>;
      stripePayoutId?: string;
      stripeTransferId?: string;
      stripeRequestId?: string;
      retryAttempt?: number;
      batchId?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    try {
      await this.payoutLogModel.create({
        payout: payoutId,
        user: userId,
        level,
        action,
        message,
        ...data,
      });

      // Also log to application logger for monitoring
      const logMessage = `[Payout ${payoutId}] ${message}`;
      switch (level) {
        case PayoutLogLevel.ERROR:
          this.logger.error(logMessage, data);
          break;
        case PayoutLogLevel.WARNING:
          this.logger.warn(logMessage, data);
          break;
        case PayoutLogLevel.SUCCESS:
          this.logger.log(logMessage, data);
          break;
        default:
          this.logger.debug(logMessage, data);
      }
    } catch (error) {
      this.logger.error('Failed to create payout log', error);
    }
  }

  /**
   * Verify that a Stripe Connect account is ready to receive payouts
   */
  private async verifyStripeConnectAccount(
    accountId: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      this.logger.debug(`Verifying Stripe Connect account: ${accountId}`);
      const accountInfo =
        await this.stripeConnectService.getAccountInfo(accountId);

      this.logger.debug(`Account info retrieved:`, {
        accountId: accountInfo.accountId,
        onboardingComplete: accountInfo.onboardingComplete,
        chargesEnabled: accountInfo.chargesEnabled,
        payoutsEnabled: accountInfo.payoutsEnabled,
        detailsSubmitted: accountInfo.detailsSubmitted,
      });

      // Check if onboarding is complete
      if (!accountInfo.onboardingComplete) {
        return {
          valid: false,
          reason: 'Stripe Connect onboarding not completed',
        };
      }

      // Check if payouts are enabled
      if (!accountInfo.payoutsEnabled) {
        return {
          valid: false,
          reason: 'Payouts not enabled on Stripe Connect account',
        };
      }

      // Check if charges are enabled
      if (!accountInfo.chargesEnabled) {
        return {
          valid: false,
          reason: 'Charges not enabled on Stripe Connect account',
        };
      }

      // Check if details are submitted
      if (!accountInfo.detailsSubmitted) {
        return {
          valid: false,
          reason: 'Account details not submitted to Stripe',
        };
      }

      this.logger.debug(`✅ Stripe Connect account verified successfully`);
      return { valid: true };
    } catch (error) {
      this.logger.error(`Failed to verify Stripe account ${accountId}:`, error);
      return {
        valid: false,
        reason: `Failed to verify Stripe account: ${error.message}`,
      };
    }
  }

  /**
   * Scan all users and initiate payouts for those with balance >= minimum
   */
  async initiateScheduledPayouts(batchId?: string): Promise<PayoutStats> {
    const generatedBatchId = batchId || uuidv4();
    const startTime = Date.now();

    this.logger.log(
      `Starting scheduled payout batch: ${generatedBatchId}`,
    );

    const stats: PayoutStats = {
      totalPayouts: 0,
      totalAmount: 0,
      successCount: 0,
      failedCount: 0,
      pendingCount: 0,
    };

    try {
      // First, log all wallets to debug
      const allWallets = await this.walletModel.find().populate('user').exec();
      this.logger.log(`Total wallets in database: ${allWallets.length}`);

      for (const wallet of allWallets) {
        const user = wallet.user as any;
        this.logger.log(`Wallet check - User: ${user?.email}, Balance: £${wallet.balance}, Locked: ${wallet.isLocked}, Min Required: £${MINIMUM_PAYOUT_AMOUNT}`);
      }

      // Find all wallets with balance >= minimum payout amount
      const eligibleWallets = await this.walletModel
        .find({
          balance: { $gte: MINIMUM_PAYOUT_AMOUNT },
          isLocked: false,
        })
        .populate('user')
        .exec();

      this.logger.log(
        `Found ${eligibleWallets.length} eligible wallets for payout (balance >= £${MINIMUM_PAYOUT_AMOUNT})`,
      );

      for (const wallet of eligibleWallets) {
        try {
          const user = wallet.user as any;

          this.logger.log(`Processing wallet for user: ${user.email} (${user._id})`);
          this.logger.log(`  - Balance: £${wallet.balance}`);
          this.logger.log(`  - Stripe Connect Account ID: ${user.stripeConnectAccountId || 'NONE'}`);

          // Validate user has Stripe Connect account set up
          if (!user.stripeConnectAccountId) {
            this.logger.warn(
              `❌ User ${user.email} (${user._id}) has balance £${wallet.balance} but NO Stripe Connect Account ID`,
            );
            continue;
          }

          // Verify Stripe Connect account status (replaces onboarding check)
          this.logger.log(`  - Verifying Stripe Connect account status via getAccountInfo...`);
          const verification = await this.verifyStripeConnectAccount(
            user.stripeConnectAccountId,
          );

          if (!verification.valid) {
            this.logger.warn(
              `❌ User ${user.email} (${user._id}) Stripe account not ready: ${verification.reason}`,
            );
            continue;
          }

          this.logger.log(`  ✅ User ${user.email} is eligible for payout!`);

          // Create payout with idempotency
          const payout = await this.createPayout(
            user._id.toString(),
            wallet.balance,
            generatedBatchId,
          );

          stats.totalPayouts++;
          stats.totalAmount += wallet.balance;
          stats.pendingCount++;

          // Queue for processing
          await this.payoutQueue.add(
            'process-payout',
            { payoutId: payout._id.toString() },
            {
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 60000, // 1 minute
              },
              removeOnComplete: false,
              removeOnFail: false,
            },
          );
        } catch (error) {
          this.logger.error(
            `Failed to create payout for wallet ${wallet._id}`,
            error,
          );
          stats.failedCount++;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Scheduled payout batch ${generatedBatchId} completed in ${duration}ms`,
        stats,
      );

      return stats;
    } catch (error) {
      this.logger.error('Failed to initiate scheduled payouts', error);
      throw error;
    }
  }

  /**
   * Create a payout record with idempotency protection
   */
  async createPayout(
    userId: string,
    amount: number,
    batchId?: string,
  ): Promise<Payout> {
    // Validate amount
    if (amount < MINIMUM_PAYOUT_AMOUNT) {
      throw new BadRequestException(
        `Minimum payout amount is £${MINIMUM_PAYOUT_AMOUNT}`,
      );
    }

    // Get user and validate
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.stripeConnectAccountId) {
      throw new BadRequestException('User has no Stripe Connect account');
    }

    // Verify Stripe Connect account is ready for payouts (checks all required fields)
    const verification = await this.verifyStripeConnectAccount(
      user.stripeConnectAccountId,
    );

    if (!verification.valid) {
      throw new BadRequestException(
        `Stripe Connect account not ready: ${verification.reason}`,
      );
    }

    // Get wallet and validate balance
    // Convert userId string to ObjectId for proper query
    const userObjectId = new Types.ObjectId(userId);
    const wallet = await this.walletModel.findOne({ user: userObjectId }).exec();
    if (!wallet) {
      this.logger.error(`Wallet not found for user ${userId} (ObjectId: ${userObjectId})`);
      this.logger.error(`Attempted query: { user: "${userId}" }`);
      this.logger.error(`Correct query should use ObjectId: { user: ObjectId("${userId}") }`);
      throw new NotFoundException('Wallet not found');
    }

    if (wallet.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }

    if (wallet.isLocked) {
      throw new BadRequestException('Wallet is locked');
    }

    // Generate idempotency key
    const idempotencyKey = `payout_${userId}_${Date.now()}_${uuidv4()}`;

    // Create payout
    const payout = await this.payoutModel.create({
      user: userId,
      amount,
      status: PayoutStatus.PENDING,
      stripeConnectAccountId: user.stripeConnectAccountId,
      idempotencyKey,
      batchId,
      scheduledDate: new Date(),
      description: `Payout of £${amount}`,
      retryCount: 0,
      maxRetries: 3,
    });

    await this.log(
      payout._id,
      new Types.ObjectId(userId),
      PayoutLogLevel.INFO,
      PayoutLogAction.INITIATED,
      `Payout initiated for £${amount}`,
      {
        batchId,
        data: {
          amount,
          walletBalance: wallet.balance,
          stripeConnectAccountId: user.stripeConnectAccountId,
        },
      },
    );

    return payout;
  }

  /**
   * Process a payout - called by the queue processor
   */
  async processPayout(payoutId: string): Promise<PayoutResult> {
    const startTime = Date.now();
    let payout = await this.payoutModel.findById(payoutId).exec();

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    // Idempotency check - if already processed, return success
    if (payout.status === PayoutStatus.PAID) {
      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.COMPLETED,
        'Payout already processed (idempotency check)',
      );

      return {
        success: true,
        payout,
        message: 'Payout already processed',
      };
    }

    // Check if payout was cancelled
    if (payout.status === PayoutStatus.CANCELLED) {
      return {
        success: false,
        payout,
        message: 'Payout was cancelled',
      };
    }

    try {
      // Update status to processing
      payout.status = PayoutStatus.PROCESSING;
      payout.processingAt = new Date();
      await payout.save();

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.PROCESSING,
        `Processing payout of £${payout.amount}`,
        {
          retryAttempt: payout.retryCount,
        },
      );

      // Get user and wallet
      const user = await this.userModel.findById(payout.user).exec();
      if (!user) {
        throw new Error('User not found');
      }

      // Re-verify Stripe Connect account before processing
      if (payout.stripeConnectAccountId) {
        const verification = await this.verifyStripeConnectAccount(
          payout.stripeConnectAccountId,
        );

        if (!verification.valid) {
          await this.log(
            payout._id,
            payout.user,
            PayoutLogLevel.ERROR,
            PayoutLogAction.ACCOUNT_ERROR,
            `Stripe account verification failed: ${verification.reason}`,
            {
              errorCode: 'ACCOUNT_NOT_READY',
              errorMessage: verification.reason,
            },
          );
          throw new Error(verification.reason);
        }
      }

      // Ensure payout.user is ObjectId for wallet query
      const userObjectId = payout.user instanceof Types.ObjectId
        ? payout.user
        : new Types.ObjectId(payout.user as string);

      const wallet = await this.walletModel.findOne({ user: userObjectId }).exec();
      if (!wallet) {
        this.logger.error(`Wallet not found in processPayout for user ${payout.user}`);
        this.logger.error(`Payout ID: ${payout._id}, User type: ${typeof payout.user}`);
        throw new Error('Wallet not found');
      }

      // Validate wallet has sufficient balance
      if (wallet.balance < payout.amount) {
        throw new Error('Insufficient wallet balance');
      }

      // Step 1: Transfer funds from platform account to user's connected account
      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.STRIPE_CALL,
        'Initiating Stripe transfer from platform to connected account',
        {
          data: {
            amount: payout.amount,
            stripeConnectAccountId: payout.stripeConnectAccountId,
          },
        },
      );

      const stripeTransfer = await this.stripeConnectService.transferToCreator(
        payout.stripeConnectAccountId!,
        payout.amount,
        `Payout to user - ${payout._id}`,
        {
          payoutId: payout._id.toString(),
          userId: user._id.toString(),
          type: 'payout',
        },
      );

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.SUCCESS,
        PayoutLogAction.STRIPE_SUCCESS,
        'Stripe transfer successful',
        {
          stripeTransferId: stripeTransfer.id,
          data: {
            stripeTransferId: stripeTransfer.id,
            stripeAmount: stripeTransfer.amount,
            stripeCurrency: stripeTransfer.currency,
            destination: stripeTransfer.destination,
          },
        },
      );

      // Step 2: Create payout from connected account to user's bank
      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.STRIPE_CALL,
        'Initiating Stripe payout from connected account to bank',
        {
          data: {
            amount: payout.amount,
            stripeConnectAccountId: payout.stripeConnectAccountId,
            transferId: stripeTransfer.id,
          },
        },
      );

      const stripePayout = await this.stripeConnectService.createPayout(
        payout.stripeConnectAccountId!,
        payout.amount,
      );

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.SUCCESS,
        PayoutLogAction.STRIPE_SUCCESS,
        'Stripe payout to bank successful',
        {
          stripePayoutId: stripePayout.id,
          stripeTransferId: stripeTransfer.id,
          data: {
            stripePayoutId: stripePayout.id,
            stripeTransferId: stripeTransfer.id,
            stripeAmount: stripePayout.amount,
            stripeCurrency: stripePayout.currency,
            stripeStatus: stripePayout.status,
          },
        },
      );

      // Deduct from wallet balance using withdrawEarnings method
      const balanceBefore = wallet.balance;
      // Note: We don't call walletService.withdrawEarnings here to avoid circular dependency
      // Instead we directly update wallet as this is already within payout transaction
      wallet.balance -= payout.amount;
      wallet.totalWithdrawn += payout.amount;
      await wallet.save();

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.BALANCE_UPDATE,
        `Wallet balance updated: £${balanceBefore} -> £${wallet.balance}`,
        {
          data: {
            balanceBefore,
            balanceAfter: wallet.balance,
            amountDeducted: payout.amount,
          },
        },
      );

      // Create transaction record
      const transaction = await this.transactionModel.create({
        user: payout.user,
        type: TransactionType.PAYOUT,
        status: TransactionStatus.COMPLETED,
        amount: payout.amount,
        balanceBefore,
        balanceAfter: wallet.balance,
        paymentMethod: PaymentMethod.STRIPE_CONNECT,
        description: `Payout to bank account`,
        metadata: {
          payoutId: payout._id.toString(),
          stripePayoutId: stripePayout.id,
          stripeTransferId: stripeTransfer.id,
          batchId: payout.batchId,
        },
      });

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.TRANSACTION_CREATED,
        'Transaction record created',
        {
          data: {
            transactionId: transaction._id.toString(),
          },
        },
      );

      // Update payout status to paid
      payout.status = PayoutStatus.PAID;
      payout.stripePayoutId = stripePayout.id;
      payout.stripeTransferId = stripeTransfer.id;
      payout.paidAt = new Date();
      await payout.save();

      const duration = Date.now() - startTime;

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.SUCCESS,
        PayoutLogAction.COMPLETED,
        `Payout completed successfully in ${duration}ms`,
        {
          durationMs: duration,
          stripePayoutId: stripePayout.id,
          stripeTransferId: stripeTransfer.id,
        },
      );

      return {
        success: true,
        payout,
        message: 'Payout completed successfully',
      };
    } catch (error) {
      return this.handlePayoutFailure(payout, error);
    }
  }

  /**
   * Handle payout failure with retry logic
   */
  private async handlePayoutFailure(
    payout: Payout,
    error: any,
  ): Promise<PayoutResult> {
    const errorMessage = error.message || 'Unknown error';
    const errorCode = error.code || 'UNKNOWN_ERROR';

    await this.log(
      payout._id,
      payout.user,
      PayoutLogLevel.ERROR,
      PayoutLogAction.FAILED,
      `Payout failed: ${errorMessage}`,
      {
        errorCode,
        errorMessage,
        errorStack: error.stack ? { stack: error.stack } : undefined,
        retryAttempt: payout.retryCount,
      },
    );

    payout.retryCount++;
    payout.failureReason = errorMessage;
    payout.failureDetails = {
      code: errorCode,
      message: errorMessage,
      timestamp: new Date(),
    };

    // Check if we should retry
    if (payout.retryCount < payout.maxRetries) {
      // Schedule retry with exponential backoff
      const delayMinutes = Math.pow(2, payout.retryCount) * 5; // 5, 10, 20 minutes
      payout.nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      payout.status = PayoutStatus.PENDING;

      await payout.save();

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.WARNING,
        PayoutLogAction.RETRY_SCHEDULED,
        `Retry scheduled for ${payout.nextRetryAt.toISOString()} (attempt ${payout.retryCount}/${payout.maxRetries})`,
        {
          retryAttempt: payout.retryCount,
          data: {
            nextRetryAt: payout.nextRetryAt,
            delayMinutes,
          },
        },
      );

      // Re-queue with delay
      await this.payoutQueue.add(
        'process-payout',
        { payoutId: payout._id.toString() },
        {
          delay: delayMinutes * 60 * 1000,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      return {
        success: false,
        payout,
        message: `Payout failed, retry scheduled (attempt ${payout.retryCount}/${payout.maxRetries})`,
      };
    } else {
      // Max retries exceeded
      payout.status = PayoutStatus.FAILED;
      payout.failedAt = new Date();
      await payout.save();

      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.ERROR,
        PayoutLogAction.FAILED,
        `Payout failed permanently after ${payout.retryCount} attempts`,
        {
          retryAttempt: payout.retryCount,
          errorCode,
          errorMessage,
        },
      );

      return {
        success: false,
        payout,
        message: 'Payout failed permanently after max retries',
      };
    }
  }

  /**
   * Cancel a pending payout
   */
  async cancelPayout(payoutId: string): Promise<Payout> {
    const payout = await this.payoutModel.findById(payoutId).exec();

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    if (payout.status !== PayoutStatus.PENDING) {
      throw new BadRequestException(
        `Cannot cancel payout with status: ${payout.status}`,
      );
    }

    payout.status = PayoutStatus.CANCELLED;
    payout.cancelledAt = new Date();
    await payout.save();

    await this.log(
      payout._id,
      payout.user,
      PayoutLogLevel.WARNING,
      PayoutLogAction.CANCELLED,
      'Payout cancelled',
    );

    return payout;
  }

  /**
   * Get payout by ID
   */
  async getPayoutById(payoutId: string): Promise<Payout> {
    const payout = await this.payoutModel
      .findById(payoutId)
      .populate('user', 'email firstName lastName')
      .exec();

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    return payout;
  }

  /**
   * Get payout logs
   */
  async getPayoutLogs(payoutId: string): Promise<PayoutLog[]> {
    return this.payoutLogModel
      .find({ payout: payoutId })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * Get user payout history
   */
  async getUserPayouts(
    userId: string,
    limit = 20,
    skip = 0,
  ): Promise<Payout[]> {
    return this.payoutModel
      .find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .exec();
  }

  /**
   * Get payouts by batch ID
   */
  async getBatchPayouts(batchId: string): Promise<Payout[]> {
    return this.payoutModel.find({ batchId }).sort({ createdAt: 1 }).exec();
  }

  /**
   * Get batch statistics
   */
  async getBatchStats(batchId: string): Promise<PayoutStats> {
    const payouts = await this.getBatchPayouts(batchId);

    return {
      totalPayouts: payouts.length,
      totalAmount: payouts.reduce((sum, p) => sum + p.amount, 0),
      successCount: payouts.filter((p) => p.status === PayoutStatus.PAID)
        .length,
      failedCount: payouts.filter((p) => p.status === PayoutStatus.FAILED)
        .length,
      pendingCount: payouts.filter(
        (p) =>
          p.status === PayoutStatus.PENDING ||
          p.status === PayoutStatus.PROCESSING,
      ).length,
    };
  }

  /**
   * Retry failed payouts that are ready for retry
   */
  async retryFailedPayouts(): Promise<number> {
    const now = new Date();
    const payoutsToRetry = await this.payoutModel
      .find({
        status: PayoutStatus.PENDING,
        nextRetryAt: { $lte: now },
        retryCount: { $lt: 3 },
      })
      .exec();

    this.logger.log(`Found ${payoutsToRetry.length} payouts ready for retry`);

    for (const payout of payoutsToRetry) {
      await this.log(
        payout._id,
        payout.user,
        PayoutLogLevel.INFO,
        PayoutLogAction.RETRY_ATTEMPTED,
        `Retrying payout (attempt ${payout.retryCount + 1})`,
      );

      await this.payoutQueue.add(
        'process-payout',
        { payoutId: payout._id.toString() },
        {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    }

    return payoutsToRetry.length;
  }

  /**
   * Admin: Get all payouts with optional filters
   */
  async getAllPayouts(
    status?: string,
    limit = 100,
    skip = 0,
  ): Promise<Payout[]> {
    const query = status ? { status } : {};

    return this.payoutModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate('user', 'email firstName lastName')
      .exec();
  }

  /**
   * Admin: Get all payout logs system-wide with filters
   */
  async getAllPayoutLogs(
    level?: string,
    action?: string,
    limit = 100,
  ): Promise<PayoutLog[]> {
    const query: any = {};
    if (level) query.level = level;
    if (action) query.action = action;

    return this.payoutLogModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .populate('payout', 'amount status')
      .exec();
  }

  /**
   * Admin: Get comprehensive payout statistics
   */
  async getPayoutStats(): Promise<{
    totalPayouts: number;
    totalAmount: number;
    totalPaid: number;
    totalPending: number;
    totalFailed: number;
    averagePayoutAmount: number;
    successRate: number;
    last24Hours: PayoutStats;
    last7Days: PayoutStats;
    last30Days: PayoutStats;
  }> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all payouts
    const allPayouts = await this.payoutModel.find().exec();
    const totalPayouts = allPayouts.length;
    const totalAmount = allPayouts.reduce((sum, p) => sum + p.amount, 0);

    const paidPayouts = allPayouts.filter((p) => p.status === PayoutStatus.PAID);
    const totalPaid = paidPayouts.reduce((sum, p) => sum + p.amount, 0);

    const pendingCount = allPayouts.filter(
      (p) =>
        p.status === PayoutStatus.PENDING ||
        p.status === PayoutStatus.PROCESSING,
    ).length;

    const failedCount = allPayouts.filter(
      (p) => p.status === PayoutStatus.FAILED,
    ).length;

    const averagePayoutAmount =
      paidPayouts.length > 0 ? totalPaid / paidPayouts.length : 0;
    const successRate =
      totalPayouts > 0 ? (paidPayouts.length / totalPayouts) * 100 : 0;

    // Get stats for different time periods
    const getStatsForPeriod = (since: Date): PayoutStats => {
      const payouts = allPayouts.filter((p) => p.createdAt >= since);
      return {
        totalPayouts: payouts.length,
        totalAmount: payouts.reduce((sum, p) => sum + p.amount, 0),
        successCount: payouts.filter((p) => p.status === PayoutStatus.PAID)
          .length,
        failedCount: payouts.filter((p) => p.status === PayoutStatus.FAILED)
          .length,
        pendingCount: payouts.filter(
          (p) =>
            p.status === PayoutStatus.PENDING ||
            p.status === PayoutStatus.PROCESSING,
        ).length,
      };
    };

    return {
      totalPayouts,
      totalAmount,
      totalPaid,
      totalPending: pendingCount,
      totalFailed: failedCount,
      averagePayoutAmount,
      successRate,
      last24Hours: getStatsForPeriod(yesterday),
      last7Days: getStatsForPeriod(weekAgo),
      last30Days: getStatsForPeriod(monthAgo),
    };
  }
}
