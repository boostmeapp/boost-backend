import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per (video, user): proof that this person already shared this video.
 * The unique index is what keeps a share counted once, however many times the
 * share sheet is opened.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'video_shares' })
export class VideoShare extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Video', required: true })
  video: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  createdAt: Date;
}

export const VideoShareSchema = SchemaFactory.createForClass(VideoShare);

// A correctness guarantee (no double counting), so it is built in production too.
VideoShareSchema.set('autoIndex', true);
VideoShareSchema.index({ video: 1, user: 1 }, { unique: true });
