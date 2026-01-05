import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum PayoutStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  PAID = 'paid',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Schema({ timestamps: true, collection: 'payouts' })
export class Payout extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  amount: number; // Amount in pounds (£)

  @Prop({
    type: String,
    enum: PayoutStatus,
    default: PayoutStatus.PENDING,
    index: true,
  })
  status: PayoutStatus;

  // Stripe Connect details
  @Prop()
  stripeConnectAccountId?: string;

  @Prop()
  stripePayoutId?: string; // Stripe Payout ID after successful payout

  @Prop()
  stripeTransferId?: string; // Stripe Transfer ID if using transfers

  // Idempotency key to prevent duplicate payouts
  @Prop({ unique: true, required: true, index: true })
  idempotencyKey: string;

  // Retry tracking
  @Prop({ default: 0 })
  retryCount: number;

  @Prop({ default: 3 })
  maxRetries: number;

  @Prop()
  nextRetryAt?: Date;

  // Failure tracking
  @Prop()
  failureReason?: string;

  @Prop({ type: Object })
  failureDetails?: Record<string, any>;

  // Timestamps for state transitions
  @Prop()
  processingAt?: Date;

  @Prop()
  paidAt?: Date;

  @Prop()
  failedAt?: Date;

  @Prop()
  cancelledAt?: Date;

  // Metadata
  @Prop({ trim: true })
  description?: string;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  // Batch information
  @Prop()
  batchId?: string; // For grouping payouts from the same scheduled run

  @Prop()
  scheduledDate?: Date; // When this payout was scheduled

  createdAt: Date;
  updatedAt: Date;
}

export const PayoutSchema = SchemaFactory.createForClass(Payout);

// Indexes for performance and queries
PayoutSchema.index({ user: 1, createdAt: -1 }); // User payout history
PayoutSchema.index({ status: 1, nextRetryAt: 1 }); // Retry queue lookup
PayoutSchema.index({ batchId: 1 }); // Batch processing
PayoutSchema.index({ createdAt: -1 }); // Recent payouts
