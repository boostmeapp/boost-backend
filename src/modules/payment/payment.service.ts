import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { WalletService } from '../wallet/wallet.service';
import { TransactionService } from '../transaction/transaction.service';
import {
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from '../../database/schemas/transaction/transaction.schema';

@Injectable()
export class PaymentService {
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
    private transactionService: TransactionService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2025-11-17.clover',
    });
  }

  /**
   * Create a payment intent for boosting a video
   */
  async createBoostPaymentIntent(
    userId: string,
    videoId: string,
    amount: number,
  ) {
    if (amount < 1) {
      throw new BadRequestException('Minimum boost amount is €1');
    }

    if (amount > 100) {
      throw new BadRequestException('Maximum boost amount is €100');
    }

    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'eur',
      metadata: {
        userId,
        videoId,
        type: 'boost_payment',
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Create pending transaction record
    await this.transactionService.create({
      userId,
      type: TransactionType.BOOST_PURCHASE,
      amount,
      balanceBefore: 0,
      balanceAfter: 0,
      paymentMethod: PaymentMethod.STRIPE,
      status: TransactionStatus.PENDING,
      stripePaymentIntentId: paymentIntent.id,
      videoId,
      description: `Boost payment of €${amount} for video`,
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    };
  }

  /**
   * Confirm a boost payment after client-side confirmation
   * This is called after the client confirms the payment
   * Note: Boost creation is handled separately - this just confirms payment
   */
  async confirmBoostPayment(paymentIntentId: string, userId: string) {
    // Verify payment intent
    const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.metadata.userId !== userId) {
      throw new BadRequestException('Payment intent does not belong to this user');
    }

    if (paymentIntent.metadata.type !== 'boost_payment') {
      throw new BadRequestException('This payment intent is not for boost payment');
    }

    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException('Payment has not succeeded yet');
    }

    // Check if already processed
    const existingTransaction = await this.transactionService.findByPaymentIntent(paymentIntentId);
    if (!existingTransaction) {
      throw new BadRequestException('Transaction not found');
    }

    if (existingTransaction.status === TransactionStatus.COMPLETED) {
      return {
        success: true,
        message: 'This payment has already been processed',
        paymentIntentId,
      };
    }

    // Update transaction status
    await this.transactionService.updateStatus(
      existingTransaction._id.toString(),
      TransactionStatus.COMPLETED,
    );

    return {
      success: true,
      message: 'Boost payment confirmed successfully',
      paymentIntentId,
      videoId: paymentIntent.metadata.videoId,
    };
  }

  async handleStripeWebhook(event: Stripe.Event) {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  }

  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    const transaction = await this.transactionService.findByPaymentIntent(paymentIntent.id);

    if (!transaction || transaction.status === TransactionStatus.COMPLETED) {
      return;
    }

    // For boost payments, just update transaction status
    // The boost creation is handled separately by the boost service
    if (paymentIntent.metadata.type === 'boost_payment') {
      await this.transactionService.updateStatus(
        transaction.id,
        TransactionStatus.COMPLETED,
      );
    }
  }

  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
    const transaction = await this.transactionService.findByPaymentIntent(paymentIntent.id);

    if (!transaction) {
      return;
    }

    await this.transactionService.updateStatus(
      transaction.id,
      TransactionStatus.FAILED,
      paymentIntent.last_payment_error?.message || 'Payment failed',
    );
  }
}
