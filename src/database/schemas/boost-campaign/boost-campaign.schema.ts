import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum CampaignGoal {
  VIEWS = 'views',
}

export enum CampaignStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed', // hit its target
  EXPIRED = 'expired', // ran out of time
  CANCELLED = 'cancelled',
}

/** Statuses that still own the video's single boost slot. */
export const LIVE_CAMPAIGN_STATUSES = [
  CampaignStatus.ACTIVE,
  CampaignStatus.PAUSED,
];

export enum CampaignEndReason {
  TARGET_REACHED = 'target_reached',
  TIME_UP = 'time_up',
  CANCELLED_BY_USER = 'cancelled_by_user',
  VIDEO_REMOVED = 'video_removed',
}

// Share of the eligible audience a boost targets (see AUDIENCE_SHARE).
export enum AudienceSize {
  SPECIFIC = 'specific', // 20%
  BALANCED = 'balanced', // 50%
  WIDE = 'wide', // 100%
}

export enum TargetAge {
  ALL = 'all',
  UNDER_18 = 'under18',
  ABOVE_18 = 'above18',
  FORTY_PLUS = '40plus',
}

export enum TargetGender {
  ALL = 'all',
  MEN = 'men',
  WOMEN = 'women',
  OTHERS = 'others',
}

@Schema({ _id: false })
export class CampaignTargeting {
  @Prop({ type: String, enum: AudienceSize, default: AudienceSize.BALANCED })
  audienceSize: AudienceSize;

  @Prop({ type: String, enum: TargetAge, default: TargetAge.ALL })
  age: TargetAge;

  @Prop({ type: String, enum: TargetGender, default: TargetGender.ALL })
  gender: TargetGender;
}

@Schema({ _id: false })
export class CampaignEngagements {
  @Prop({ default: 0 }) likes: number;
  @Prop({ default: 0 }) comments: number;
  @Prop({ default: 0 }) follows: number;
}

/**
 * A coin-paid boost on one video. Coins are reserved at creation and the
 * undelivered share is refunded when the campaign ends — see
 * docs/boost-campaigns/README.md.
 */
@Schema({ timestamps: true, collection: 'boost_campaigns' })
export class BoostCampaign extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Video', required: true })
  video: Types.ObjectId;

  @Prop({ type: String, enum: CampaignGoal, default: CampaignGoal.VIEWS })
  goal: CampaignGoal;

  @Prop({ type: CampaignTargeting, required: true })
  targeting: CampaignTargeting;

  // Money
  @Prop({ required: true, min: 0 })
  coinsRequested: number;

  @Prop({ required: true, min: 0 })
  coinsCharged: number;

  @Prop({ default: 0, min: 0 })
  coinsRefunded: number;

  @Prop({ required: true, min: 1 })
  viewsPerCoin: number; // snapshot, so later config changes don't reprice it

  // Delivery
  @Prop({ required: true, min: 0 })
  targetViews: number;

  @Prop({ default: 0, min: 0 })
  deliveredViews: number;

  @Prop({ default: 0, min: 0 })
  impressions: number;

  @Prop({ default: 0, min: 0 })
  uniqueReach: number;

  @Prop({ type: CampaignEngagements, default: () => ({}) })
  engagements: CampaignEngagements;

  @Prop({ default: 0 })
  eligibleAudienceAtStart: number;

  // Lifecycle
  @Prop({ type: String, enum: CampaignStatus, default: CampaignStatus.ACTIVE })
  status: CampaignStatus;

  @Prop({ required: true })
  durationDays: number;

  @Prop({ required: true })
  startAt: Date;

  @Prop({ required: true })
  endAt: Date;

  @Prop()
  endedAt?: Date;

  @Prop({ type: String, enum: CampaignEndReason })
  endReason?: CampaignEndReason;

  // Client-supplied, so a double-tapped "Boost Now" can't charge twice.
  @Prop({ required: true })
  idempotencyKey: string;

  createdAt: Date;
  updatedAt: Date;
}

export const BoostCampaignSchema = SchemaFactory.createForClass(BoostCampaign);
// The unique indexes below are correctness guarantees (no double charge,
// no double count), so they're built in production too.
BoostCampaignSchema.set('autoIndex', true);

BoostCampaignSchema.index({ status: 1, endAt: 1 }); // expiry sweep
BoostCampaignSchema.index({ user: 1, createdAt: -1 }); // dashboard
BoostCampaignSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
// One live campaign per video.
BoostCampaignSchema.index(
  { video: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: LIVE_CAMPAIGN_STATUSES } },
  },
);
