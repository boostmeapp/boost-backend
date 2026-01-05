import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum PayoutLogLevel {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  SUCCESS = 'success',
}

export enum PayoutLogAction {
  INITIATED = 'initiated',
  PROCESSING = 'processing',
  RETRY_SCHEDULED = 'retry_scheduled',
  RETRY_ATTEMPTED = 'retry_attempted',
  STRIPE_CALL = 'stripe_call',
  STRIPE_SUCCESS = 'stripe_success',
  STRIPE_ERROR = 'stripe_error',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  VALIDATION_ERROR = 'validation_error',
  ACCOUNT_ERROR = 'account_error',
  BALANCE_UPDATE = 'balance_update',
  TRANSACTION_CREATED = 'transaction_created',
}

@Schema({ timestamps: true, collection: 'payout_logs' })
export class PayoutLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Payout', required: true, index: true })
  payout: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({
    type: String,
    enum: PayoutLogLevel,
    default: PayoutLogLevel.INFO,
    index: true,
  })
  level: PayoutLogLevel;

  @Prop({
    type: String,
    enum: PayoutLogAction,
    required: true,
    index: true,
  })
  action: PayoutLogAction;

  @Prop({ required: true })
  message: string;

  // Detailed information
  @Prop({ type: Object })
  data?: Record<string, any>;

  // Error details if applicable
  @Prop()
  errorCode?: string;

  @Prop()
  errorMessage?: string;

  @Prop({ type: Object })
  errorStack?: Record<string, any>;

  // Stripe-specific details
  @Prop()
  stripePayoutId?: string;

  @Prop()
  stripeTransferId?: string;

  @Prop()
  stripeRequestId?: string;

  // Execution context
  @Prop()
  retryAttempt?: number;

  @Prop()
  batchId?: string;

  // Performance tracking
  @Prop()
  durationMs?: number; // How long the operation took

  createdAt: Date;
  updatedAt: Date;
}

export const PayoutLogSchema = SchemaFactory.createForClass(PayoutLog);

// Indexes for efficient querying
PayoutLogSchema.index({ payout: 1, createdAt: 1 }); // Chronological logs for a payout
PayoutLogSchema.index({ user: 1, createdAt: -1 }); // User payout activity
PayoutLogSchema.index({ level: 1, createdAt: -1 }); // Filter by log level
PayoutLogSchema.index({ action: 1, createdAt: -1 }); // Filter by action
PayoutLogSchema.index({ batchId: 1, createdAt: 1 }); // Batch processing logs
PayoutLogSchema.index({ createdAt: -1 }); // Recent logs (for cleanup/monitoring)
