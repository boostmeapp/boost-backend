import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * A qualified view attributed to a campaign. The unique (campaign, viewer)
 * index is what makes a viewer count at most once.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'boost_views',
})
export class BoostView extends Document {
  @Prop({ type: Types.ObjectId, ref: 'BoostCampaign', required: true })
  campaign: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewer: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Video', required: true })
  video: Types.ObjectId;

  @Prop({ required: true })
  watchSeconds: number;

  createdAt: Date;
}

export const BoostViewSchema = SchemaFactory.createForClass(BoostView);
// The unique indexes below are correctness guarantees (no double charge,
// no double count), so they're built in production too.
BoostViewSchema.set('autoIndex', true);

BoostViewSchema.index({ campaign: 1, viewer: 1 }, { unique: true });
