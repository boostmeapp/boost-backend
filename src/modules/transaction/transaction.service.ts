import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from '../../database/schemas/transaction/transaction.schema';

export interface CreateTransactionDto {
  userId: string;
  type: TransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  paymentMethod: PaymentMethod;
  status?: TransactionStatus;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  videoId?: string;
  boostId?: string;
  description?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class TransactionService {
  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<Transaction>,
  ) {}

  async create(dto: CreateTransactionDto): Promise<Transaction> {
    const transaction = new this.transactionModel({
      user: new Types.ObjectId(dto.userId),
      type: dto.type,
      amount: dto.amount,
      balanceBefore: dto.balanceBefore,
      balanceAfter: dto.balanceAfter,
      paymentMethod: dto.paymentMethod,
      status: dto.status || TransactionStatus.PENDING,
      stripePaymentIntentId: dto.stripePaymentIntentId,
      stripeChargeId: dto.stripeChargeId,
      video: dto.videoId ? new Types.ObjectId(dto.videoId) : undefined,
      boost: dto.boostId ? new Types.ObjectId(dto.boostId) : undefined,
      description: dto.description,
      metadata: dto.metadata,
    });

    return transaction.save();
  }

  async updateStatus(
    transactionId: string,
    status: TransactionStatus,
    failureReason?: string,
  ): Promise<Transaction> {
    const transaction = await this.transactionModel
      .findByIdAndUpdate(
        transactionId,
        {
          status,
          ...(failureReason && { failureReason }),
        },
        { new: true },
      )
      .exec();

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return transaction;
  }

  async findByPaymentIntent(paymentIntentId: string): Promise<Transaction | null> {
    return this.transactionModel
      .findOne({ stripePaymentIntentId: paymentIntentId })
      .exec();
  }

  async getUserTransactions(userId: string, limit: number = 50): Promise<Transaction[]> {
    return this.transactionModel
      .find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('video', 'title thumbnailUrl')
      .populate('boost', 'package status')
      .exec();
  }

  async getUserTransactionsByType(
    userId: string,
    type: TransactionType,
    limit: number = 50,
  ): Promise<Transaction[]> {
    return this.transactionModel
      .find({ user: userId, type })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('video', 'title thumbnailUrl')
      .populate('boost', 'package status')
      .exec();
  }

  // Admin: Get all transactions
  async getAllTransactions(limit: number = 100): Promise<Transaction[]> {
    return this.transactionModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .populate('video', 'title')
      .populate('boost', 'package status')
      .exec();
  }

  // Admin: Get transactions by status
  async getTransactionsByStatus(
    status: TransactionStatus,
    limit: number = 100,
  ): Promise<Transaction[]> {
    return this.transactionModel
      .find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .populate('video', 'title')
      .populate('boost', 'package status')
      .exec();
  }

  // Admin: Get user's total spending
  async getUserTotalSpending(userId: string): Promise<number> {
    const result = await this.transactionModel.aggregate([
      {
        $match: {
          user: new Types.ObjectId(userId),
          type: TransactionType.BOOST_PURCHASE,
          status: TransactionStatus.COMPLETED,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
        },
      },
    ]);

    return result.length > 0 ? result[0].total : 0;
  }

  // Get user's total earnings (from watching videos)
  async getUserTotalEarnings(userId: string): Promise<number> {
    const result = await this.transactionModel.aggregate([
      {
        $match: {
          user: new Types.ObjectId(userId),
          type: TransactionType.REWARD_EARNED,
          status: TransactionStatus.COMPLETED,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
        },
      },
    ]);

    return result.length > 0 ? result[0].total : 0;
  }

  // Admin: Get all transactions with filters
  async getAllTransactionsAdmin(
    type?: TransactionType,
    status?: TransactionStatus,
    limit = 100,
    skip = 0,
  ): Promise<Transaction[]> {
    const query: any = {};
    if (type) query.type = type;
    if (status) query.status = status;

    return this.transactionModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate('user', 'email firstName lastName')
      .populate('video', 'title')
      .populate('boost', 'package status')
      .exec();
  }

  // Admin: Get comprehensive transaction statistics
  async getTransactionStats(): Promise<{
    totalTransactions: number;
    totalVolume: number;
    totalBoostPurchases: number;
    totalBoostVolume: number;
    totalRewardsEarned: number;
    totalRewardsVolume: number;
    totalPayouts: number;
    totalPayoutVolume: number;
    last24Hours: any;
    last7Days: any;
    last30Days: any;
  }> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all transactions
    const allTransactions = await this.transactionModel.find().exec();
    const totalTransactions = allTransactions.length;
    const totalVolume = allTransactions
      .filter((t) => t.status === TransactionStatus.COMPLETED)
      .reduce((sum, t) => sum + t.amount, 0);

    // Boost purchases
    const boostPurchases = allTransactions.filter(
      (t) =>
        t.type === TransactionType.BOOST_PURCHASE &&
        t.status === TransactionStatus.COMPLETED,
    );
    const totalBoostPurchases = boostPurchases.length;
    const totalBoostVolume = boostPurchases.reduce(
      (sum, t) => sum + t.amount,
      0,
    );

    // Rewards earned
    const rewardsEarned = allTransactions.filter(
      (t) =>
        t.type === TransactionType.REWARD_EARNED &&
        t.status === TransactionStatus.COMPLETED,
    );
    const totalRewardsEarned = rewardsEarned.length;
    const totalRewardsVolume = rewardsEarned.reduce(
      (sum, t) => sum + t.amount,
      0,
    );

    // Payouts
    const payouts = allTransactions.filter(
      (t) =>
        t.type === TransactionType.PAYOUT &&
        t.status === TransactionStatus.COMPLETED,
    );
    const totalPayouts = payouts.length;
    const totalPayoutVolume = payouts.reduce((sum, t) => sum + t.amount, 0);

    // Get stats for different time periods
    const getStatsForPeriod = (since: Date) => {
      const transactions = allTransactions.filter((t) => t.createdAt >= since);
      return {
        totalTransactions: transactions.length,
        totalVolume: transactions
          .filter((t) => t.status === TransactionStatus.COMPLETED)
          .reduce((sum, t) => sum + t.amount, 0),
        boostPurchases: transactions.filter(
          (t) => t.type === TransactionType.BOOST_PURCHASE,
        ).length,
        rewardsEarned: transactions.filter(
          (t) => t.type === TransactionType.REWARD_EARNED,
        ).length,
        payouts: transactions.filter((t) => t.type === TransactionType.PAYOUT)
          .length,
      };
    };

    return {
      totalTransactions,
      totalVolume,
      totalBoostPurchases,
      totalBoostVolume,
      totalRewardsEarned,
      totalRewardsVolume,
      totalPayouts,
      totalPayoutVolume,
      last24Hours: getStatsForPeriod(yesterday),
      last7Days: getStatsForPeriod(weekAgo),
      last30Days: getStatsForPeriod(monthAgo),
    };
  }
}
