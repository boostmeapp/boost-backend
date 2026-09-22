import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per (campaign, viewer): the viewer was served the video in a boost
 * slot. Drives the per-day frequency cap and proves a view came from the boost.
 */
@Schema({ collection: 'boost_impressions' })
export class BoostImpression extends Document {
  @Prop({ type: Types.ObjectId, ref: 'BoostCampaign', required: true })
  campaign: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewer: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Video', required: true })
  video: Types.ObjectId;

  @Prop({ required: true })
  firstServedAt: Date;

  @Prop({ required: true })
  lastServedAt: Date;

  // UTC day ('YYYY-MM-DD') that servesToday counts for.
  @Prop({ required: true })
  servesDay: string;

  @Prop({ default: 0 })
  servesToday: number;

  @Prop({ default: 0 })
  totalServes: number;
}

export const BoostImpressionSchema =
  SchemaFactory.createForClass(BoostImpression);
// The unique indexes below are correctness guarantees (no double charge,
// no double count), so they're built in production too.
BoostImpressionSchema.set('autoIndex', true);

BoostImpressionSchema.index({ campaign: 1, viewer: 1 }, { unique: true });
BoostImpressionSchema.index({ viewer: 1, video: 1 }); // engagement attribution
// The campaign keeps its own totals; old rows are only needed for a while.
BoostImpressionSchema.index(
  { lastServedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600 },
);
