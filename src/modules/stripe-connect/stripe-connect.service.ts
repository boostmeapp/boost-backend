import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { User } from '../../database/schemas/user/user.schema';

export interface ConnectAccountLink {
  url: string;
  expiresAt: number;
}

export interface ConnectAccountInfo {
  accountId: string;
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

@Injectable()
export class StripeConnectService {
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2025-11-17.clover'
    });
  }

  async createConnectAccount(userId: string, email: string): Promise<ConnectAccountInfo> {
    // Create Connect account
    const account = await this.stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      settings: {
        payouts: {
          schedule: {
            interval: 'manual', // Manual payouts for more control
          },
        },
      },
    });

    const user = await this.userModel.findById(userId).exec();
    if (user) {
      user.stripeConnectAccountId = account.id;
      user.stripeAccountType = 'express';
      user.stripeOnboardingComplete = false;
      await user.save();
    }

    return {
      accountId: account.id,
      onboardingComplete: false,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    };
  }

  async createOnboardingLink(userId: string): Promise<ConnectAccountLink> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.stripeConnectAccountId) {
      throw new BadRequestException('User does not have a Connect account');
    }

    const returnUrl = this.configService.get<string>('FRONTEND_URL','http://localhost:3000') + '/dashboard/payments/connect-return';
    const refreshUrl = this.configService.get<string>('FRONTEND_URL','http://localhost:3000') + '/dashboard/payments/connect-refresh';

    const accountLink = await this.stripe.accountLinks.create({
      account: user.stripeConnectAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return {
      url: accountLink.url,
      expiresAt: accountLink.expires_at,
    };
  }

  
  async createLoginLink(userId: string): Promise<string> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.stripeConnectAccountId) {
      throw new BadRequestException('User does not have a Connect account');
    }

    const loginLink = await this.stripe.accounts.createLoginLink(
      user.stripeConnectAccountId,
    );

    return loginLink.url;
  }

  /**
   * Get account information
   */
  async getAccountInfo(accountId: string): Promise<ConnectAccountInfo> {
    const account = await this.stripe.accounts.retrieve(accountId);

    return {
      accountId: account.id,
      onboardingComplete: account.details_submitted && account.charges_enabled,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    };
  }

  /**
   * Update user's onboarding status after completing Stripe Connect
   */
  async updateOnboardingStatus(userId: string): Promise<User> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.stripeConnectAccountId) {
      throw new NotFoundException('User or Connect account not found');
    }

    const accountInfo = await this.getAccountInfo(user.stripeConnectAccountId);

    user.stripeOnboardingComplete = accountInfo.onboardingComplete;
    return user.save();
  }

  /**
   * Transfer funds to creator's connected account
   */
  async transferToCreator(
    connectedAccountId: string,
    amount: number, // Amount in platform currency
    description: string,
    metadata?: Record<string, string>,
  ): Promise<Stripe.Transfer> {
    const transfer = await this.stripe.transfers.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd', // Platform account currency
      destination: connectedAccountId,
      description,
      metadata,
    });

    return transfer;
  }


  async createPayout(
    connectedAccountId: string,
    amount: number, // Amount in platform currency
  ): Promise<Stripe.Payout> {
    const payout = await this.stripe.payouts.create(
      {
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd', // Platform account currency
      },
      {
        stripeAccount: connectedAccountId,
      },
    );

    return payout;
  }

  /**
   * TEST MODE ONLY: Add funds to platform account by creating a test charge
   * Uses Stripe test card 4000000000000077 which adds to available balance
   */
  async addTestPlatformFunds(amount: number): Promise<{
    success: boolean;
    chargeId: string;
    amount: number;
    currency: string;
    message: string;
  }> {
    try {
      // Create a charge using the test card that adds to available balance
      const charge = await this.stripe.charges.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'eur',
        source: 'tok_bypassPending', // Special test token that adds to available balance immediately
        description: 'Test platform balance top-up for payouts',
        metadata: {
          type: 'test_platform_funding',
          purpose: 'payout_testing',
        },
      });

      return {
        success: true,
        chargeId: charge.id,
        amount: charge.amount / 100,
        currency: charge.currency,
        message: `Successfully added €${amount} to platform available balance for testing`,
      };
    } catch (error) {
      throw new Error(`Failed to add test platform funds: ${error.message}`);
    }
  }

  async getAccountBalance(connectedAccountId?: string): Promise<{
    available: number;
    pending: number;
    currency?: string;
    allBalances?: Array<{ currency: string; available: number; pending: number }>;
  }> {
    // If no account ID provided, get platform account balance
    const balance = connectedAccountId
      ? await this.stripe.balance.retrieve({ stripeAccount: connectedAccountId })
      : await this.stripe.balance.retrieve();

    // Build array of all balances by currency
    const allBalances: Array<{ currency: string; available: number; pending: number }> = [];
    const currencies = new Set([
      ...balance.available.map(b => b.currency),
      ...balance.pending.map(b => b.currency),
    ]);

    for (const currency of currencies) {
      const availableBal = balance.available.find((b) => b.currency === currency);
      const pendingBal = balance.pending.find((b) => b.currency === currency);

      allBalances.push({
        currency: currency.toUpperCase(),
        available: availableBal ? availableBal.amount / 100 : 0,
        pending: pendingBal ? pendingBal.amount / 100 : 0,
      });
    }

    // Prioritize: EUR > USD > first available currency
    let primaryCurrency = balance.available.find((b) => b.currency === 'eur') ||
                          balance.available.find((b) => b.currency === 'usd') ||
                          balance.available[0];

    const primaryCurrencyCode = primaryCurrency?.currency || 'eur';
    const availablePrimary = balance.available.find((b) => b.currency === primaryCurrencyCode);
    const pendingPrimary = balance.pending.find((b) => b.currency === primaryCurrencyCode);

    return {
      available: availablePrimary ? availablePrimary.amount / 100 : 0,
      pending: pendingPrimary ? pendingPrimary.amount / 100 : 0,
      currency: primaryCurrencyCode.toUpperCase(),
      allBalances,
    };
  }


  async handleConnectWebhook(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'account.updated':
        await this.handleAccountUpdated(event.data.object as Stripe.Account);
        break;
      case 'account.external_account.created':
      case 'account.external_account.updated':
        // Handle bank account updates
        break;
      default:
        console.log(`Unhandled Connect event type: ${event.type}`);
    }
  }

  private async handleAccountUpdated(account: Stripe.Account): Promise<void> {
    // Find user with this Connect account
    const user = await this.userModel
      .findOne({ stripeConnectAccountId: account.id })
      .exec();

    if (user) {
      user.stripeOnboardingComplete = account.details_submitted && account.charges_enabled;
      await user.save();
    }
  }
}
