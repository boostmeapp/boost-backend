import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum TransactionType {
  DEPOSIT = 'deposit',
  WITHDRAWAL = 'withdrawal',
  BOOST_PURCHASE = 'boost-purchase',
  REWARD_EARNED = 'reward-earned',
  PAYOUT = 'payout',
  REFUND = 'refund',
}

export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum PaymentMethod {
  STRIPE = 'stripe',
  WALLET = 'wallet',
  REWARD = 'reward',
  STRIPE_CONNECT = 'stripe-connect',
}

@Schema({ timestamps: true, collection: 'transactions' })
export class Transaction extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({
    type: String,
    enum: TransactionType,
    required: true,
    index: true,
  })
  type: TransactionType;

  @Prop({
    type: String,
    enum: TransactionStatus,
    default: TransactionStatus.PENDING,
    index: true,
  })
  status: TransactionStatus;

  @Prop({ required: true })
  amount: number; // Amount in pounds (£)

  @Prop({ required: true })
  balanceBefore: number;

  @Prop({ required: true })
  balanceAfter: number;

  @Prop({
    type: String,
    enum: PaymentMethod,
    required: true,
  })
  paymentMethod: PaymentMethod;

  // Stripe integration
  @Prop()
  stripePaymentIntentId?: string;

  @Prop()
  stripeChargeId?: string;

  // Related entities
  @Prop({ type: Types.ObjectId, ref: 'Video' })
  video?: Types.ObjectId; // For boost purchases

  @Prop({ type: Types.ObjectId, ref: 'Boost' })
  boost?: Types.ObjectId; // Link to boost record

  // Metadata
  @Prop({ trim: true })
  description?: string;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop()
  failureReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

// Indexes for performance
TransactionSchema.index({ user: 1, createdAt: -1 }); // User transaction history
TransactionSchema.index({ status: 1, createdAt: -1 }); // Filter by status
TransactionSchema.index({ type: 1, createdAt: -1 }); // Filter by type
TransactionSchema.index({ stripePaymentIntentId: 1 }); // Stripe webhook lookup