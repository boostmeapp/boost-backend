import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum StoryMediaType {
  Image = 'image',
  Video = 'video',
}

export enum StoryStatus {
  Active = 'active',
  /** Past its 24 hours. Kept for history — never removed. */
  Expired = 'expired',
  /** Taken down by its owner. Also kept. */
  Deleted = 'deleted',
}

/**
 * One story item: a photo or a short clip that is live for 24 hours.
 *
 * Rows are never removed — expiry only flips `status`, so the archive stays
 * intact. There is deliberately no TTL index on this collection.
 */
@Schema({ timestamps: true, collection: 'stories' })
export class Story extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ type: String, enum: StoryMediaType, required: true })
  mediaType: StoryMediaType;

  /** S3 key of the photo or clip. */
  @Prop({ required: true })
  mediaKey: string;

  /** Poster frame for a video story. */
  @Prop()
  thumbnailKey?: string;

  /** Clip length in seconds. Capped at MAX_STORY_VIDEO_SECONDS on create. */
  @Prop()
  durationSeconds?: number;

  @Prop()
  music?: string;

  @Prop({ type: String, enum: StoryStatus, default: StoryStatus.Active })
  status: StoryStatus;

  /** createdAt + 24h. Every read filters on this, not only on `status`. */
  @Prop({ required: true })
  expiresAt: Date;

  /** When the sweep or the delayed job actually flipped it. */
  @Prop()
  expiredAt?: Date;

  @Prop({ default: 0 })
  viewCount: number;

  /** Viewers who hearted it. Kept in step with the `liked` view rows. */
  @Prop({ default: 0 })
  likeCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export const StorySchema = SchemaFactory.createForClass(Story);

// "Whose stories are live" — the feed's access path.
StorySchema.index({ user: 1, status: 1, expiresAt: 1, createdAt: 1 });
// The expiry sweep.
StorySchema.index({ status: 1, expiresAt: 1 });
// A profile's archive, newest first.
StorySchema.index({ user: 1, createdAt: -1 });
