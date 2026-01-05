import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum EarningStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}

export enum PayoutStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({ timestamps: true, collection: 'user_earnings' })
export class UserEarning extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Video', required: true, index: true })
  video: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'VideoReward', required: true })
  videoReward: Types.ObjectId;

  @Prop({ required: true })
  amount: number; // Amount earned

  @Prop({
    type: String,
    enum: EarningStatus,
    default: EarningStatus.COMPLETED,
  })
  status: EarningStatus;

  @Prop({ required: true })
  watchDuration: number; // How long the user watched (seconds)

  @Prop({ required: true })
  videoDuration: number; // Total video duration (seconds)

  @Prop({ required: true })
  watchPercentage: number; // Percentage watched

  createdAt: Date;
  updatedAt: Date;
}

export const UserEarningSchema = SchemaFactory.createForClass(UserEarning);

// Indexes
UserEarningSchema.index({ user: 1, createdAt: -1 });
UserEarningSchema.index({ video: 1, user: 1 }, { unique: true }); // One earning per user per video
UserEarningSchema.index({ status: 1 });

// Reward Pool Stats Schema - tracks total system rewards
@Schema({ timestamps: true, collection: 'reward_pool_stats' })
export class RewardPoolStats extends Document {
  @Prop({ required: true, default: 0 })
  totalPoolAllocated: number; // Total amount put into reward pools

  @Prop({ required: true, default: 0 })
  totalDistributed: number; // Total distributed to users

  @Prop({ required: true, default: 0 })
  totalPendingRewards: number; // Rewards not yet distributed

  @Prop({ required: true, default: 0 })
  totalUsers: number; // Users who have earned rewards

  @Prop({ required: true, default: 0 })
  totalEarnings: number; // Total earnings across all users

  updatedAt: Date;
}

export const RewardPoolStatsSchema = SchemaFactory.createForClass(RewardPoolStats);

// User Reward Balance Schema - tracks user's available balance
@Schema({ timestamps: true, collection: 'user_reward_balances' })
export class UserRewardBalance extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  availableBalance: number; // Available for withdrawal

  @Prop({ required: true, default: 0 })
  totalEarned: number; // Lifetime earnings

  @Prop({ required: true, default: 0 })
  totalWithdrawn: number; // Lifetime withdrawals

  @Prop({ required: true, default: 0 })
  pendingWithdrawal: number; // Currently processing withdrawals

  @Prop({ default: 1.0 }) // Minimum £1 for withdrawal
  minimumWithdrawal: number;

  createdAt: Date;
  updatedAt: Date;
}

export const UserRewardBalanceSchema = SchemaFactory.createForClass(UserRewardBalance);

// Production index for payout threshold queries
UserRewardBalanceSchema.index({ availableBalance: 1 }); // Find users eligible for payout

// Payout Request Schema
@Schema({ timestamps: true, collection: 'payout_requests' })
export class PayoutRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true })
  amount: number;

  @Prop({
    type: String,
    enum: PayoutStatus,
    default: PayoutStatus.PENDING,
    index: true,
  })
  status: PayoutStatus;

  @Prop()
  stripeTransferId?: string;

  @Prop()
  failureReason?: string;

  @Prop()
  processedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const PayoutRequestSchema = SchemaFactory.createForClass(PayoutRequest);

PayoutRequestSchema.index({ user: 1, createdAt: -1 });
PayoutRequestSchema.index({ status: 1 });
