import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'video_rewards' })
export class VideoReward extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Video', required: true, unique: true, index: true })
  video: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Boost', required: true, index: true })
  boost: Types.ObjectId;

  @Prop({ required: true })
  totalRewardPool: number; // Total amount allocated for rewards

  @Prop({ required: true, default: 0 })
  distributedRewards: number; // Amount already distributed

  @Prop({ required: true })
  remainingRewards: number; // Amount still available

  @Prop({ required: true })
  rewardPerView: number; // Reward amount per complete view

  @Prop({ required: true, default: 0 })
  totalViews: number; // Total views that earned rewards

  @Prop({ required: true, default: 0 })
  eligibleViews: number; // Views that watched full video

  @Prop({ default: false })
  isActive: boolean; // Whether rewards are still being distributed

  @Prop()
  endDate: Date; // When reward period ends

  createdAt: Date;
  updatedAt: Date;
}

export const VideoRewardSchema = SchemaFactory.createForClass(VideoReward);

// Indexes
VideoRewardSchema.index({ video: 1, isActive: 1 });
VideoRewardSchema.index({ boost: 1 });
