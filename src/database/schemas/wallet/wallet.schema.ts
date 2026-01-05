import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'wallets' })
export class Wallet extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, default: 0, min: 0 })
  balance: number; // Current balance in pounds (£) - earnings from watching videos (withdrawable)

  @Prop({ required: true, default: 0, min: 0 })
  totalEarned: number; // Lifetime earnings from watching videos

  @Prop({ required: true, default: 0, min: 0 })
  totalWithdrawn: number; // Lifetime withdrawals via Stripe Connect

  // Stripe Connect sync
  @Prop()
  stripeConnectBalance?: number; // Last synced balance from Stripe Connect account

  @Prop()
  lastStripeSyncAt?: Date; // Last time we synced with Stripe

  @Prop({ default: false })
  isLocked: boolean; // Lock wallet for suspicious activity

  @Prop()
  lockedReason?: string;

  @Prop()
  lockedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = SchemaFactory.createForClass(Wallet);

// Ensure balance never goes negative
WalletSchema.pre('save', function (next) {
  if (this.balance < 0) {
    next(new Error('Wallet balance cannot be negative'));
  }
  next();
});

// Production-critical indexes for payout queries
WalletSchema.index({ balance: 1, isLocked: 1 }); // Payout eligibility lookup
WalletSchema.index({ isLocked: 1, lockedAt: -1 }); // Security audits
WalletSchema.index({ totalEarned: -1 }); // Top earners analytics
