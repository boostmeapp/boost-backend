import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum BoostStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

// Configurable reward system parameters
export const REWARD_CONFIG = {
  REWARD_POOL_PERCENTAGE: 0.20, // 20% goes to reward pool
  PLATFORM_REVENUE_PERCENTAGE: 0.80, // 80% is platform revenue
  FIXED_REWARD_PER_VIEW: 0.0003, // €0.0003 per qualified view
  MIN_BOOST_AMOUNT: 1, // Minimum €1
  MAX_BOOST_AMOUNT: 100, // Maximum €100
};

export enum BoostPackage {
  CUSTOM = 'custom', // Legacy: user chose any amount €1-€100 (Stripe)
  IAP = 'iap', // One-time fixed-duration package bought via App Store / Play billing
}

export enum BoostPlatform {
  IOS = 'ios',
  ANDROID = 'android',
}

export enum BoostSource {
  STRIPE = 'stripe', // legacy
  IAP = 'iap',
}

export const BOOST_PACKAGES = {
  [BoostPackage.CUSTOM]: {
    minPrice: REWARD_CONFIG.MIN_BOOST_AMOUNT,
    maxPrice: REWARD_CONFIG.MAX_BOOST_AMOUNT,
    description: 'Pay any amount between €1 and €100',
  },
};

@Schema({ timestamps: true, collection: 'boosts' })
export class Boost extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Video', required: true, index: true })
  video: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId; // Who created the boost

  @Prop({
    type: String,
    enum: BoostPackage,
    required: true,
  })
  package: BoostPackage;
@Prop({ required: false })
endDate?: Date;

  @Prop({ required: true })
  amount: number; // Price paid

  @Prop({ required: true })
  targetViews: number; // Target views from package

  @Prop({ default: 0 })
  currentViews: number; // Views gained from boost

  @Prop({ required: true })
  duration: number; // Duration in hours

  @Prop({ required: true })
  startDate: Date;


  @Prop({ type: String, enum: BoostStatus, default: BoostStatus.PENDING, index: true })
  status: BoostStatus;

  @Prop({ type: Types.ObjectId, ref: 'Transaction' })
  transaction: Types.ObjectId;

  // ── In-App Purchase (App Store / Google Play) ──
  @Prop({ type: String, enum: BoostSource, default: BoostSource.STRIPE })
  source: BoostSource;

  @Prop({ type: String, enum: BoostPlatform })
  platform?: BoostPlatform;

  // The purchased BoostProduct key
  @Prop()
  productKey?: string;

  // Store transaction id — unique to prevent replay / double-activation
  @Prop({ index: true })
  storeTransactionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const BoostSchema = SchemaFactory.createForClass(Boost);

// Indexes
BoostSchema.index({ video: 1, status: 1 });
BoostSchema.index({ user: 1, createdAt: -1 });
BoostSchema.index({ status: 1, startDate: 1, endDate: 1 });
// Prevent the same store purchase from activating two boosts
BoostSchema.index(
  { storeTransactionId: 1 },
  { unique: true, sparse: true },
);
