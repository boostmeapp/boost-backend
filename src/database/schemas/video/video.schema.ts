import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

// HLS chunk info
export class VideoChunk {
  
  @Prop({ required: true })
  quality: string; // '360p', '720p', '1080p'

  @Prop({ required: true })
  resolution: string; // '640x360', '1280x720', '1920x1080'

  @Prop({ required: true })
  bitrate: number;

  @Prop({ required: true })
  playlistUrl: string; // S3 URL to playlist.m3u8

  @Prop({ required: true })
  segmentPattern: string; // Pattern for segments

  @Prop({ default: 4 })
  segmentDuration: number; // Seconds per chunk

  @Prop({ required: true })
  totalSegments: number;
}

@Schema({ timestamps: true, collection: 'videos' })
export class Video extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ trim: true })
  caption?: string; // Short caption/overlay text for the video

  @Prop({ type: [String], default: [], index: true })
  tags: string[]; // Array of tag names

  @Prop({ required: true })
  thumbnailUrl: string;

  @Prop({ required: true })
  duration: number; // Total duration in seconds

  // S3 Storage
  @Prop({ required: true })
  rawVideoKey: string; // Original upload key in S3

  @Prop()
  processedVideoKey?: string; // Processed video folder key

  // HLS Streaming
  @Prop()
  manifestUrl?: string; // Master playlist URL

  @Prop({ type: [VideoChunk], default: [] })
  chunks: VideoChunk[];

  // Processing
  @Prop({
    type: String,
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.UPLOADING,
    index: true,
  })
  processingStatus: VideoProcessingStatus;

  @Prop({ default: 0, min: 0, max: 100 })
  processingProgress: number;

  // Stats
  @Prop({ default: 0, index: true })
  viewCount: number;

  @Prop({ default: 0 })
  likeCount: number;

  @Prop({ default: 0 })
  commentCount: number;

  @Prop({ default: 0 })
  shareCount: number;

  @Prop({ default: 0 })
  watchTimeTotal: number; // Total seconds watched across all users

  // Boost
  @Prop({ default: false, index: true })
  isBoosted: boolean;

  @Prop({ default: 0, index: true })
  boostScore: number; // Calculated score for ranking

  @Prop()
  boostStartDate?: Date;

  @Prop()
  boostEndDate?: Date;

  // Reward Pool (for boosted videos)
  @Prop({ default: false })
  hasRewardPool: boolean;

  @Prop({ default: 0 })
  rewardPoolAmount: number; // Total reward pool for this video

  @Prop({ default: 0 })
  rewardPoolDistributed: number; // Amount already distributed

  @Prop({ default: 0 })
  rewardEligibleViews: number; // Views that earned rewards

  createdAt: Date;
  updatedAt: Date;
}

export const VideoSchema = SchemaFactory.createForClass(Video);
VideoSchema.set('autoIndex', true);


// Add pagination plugin
VideoSchema.plugin(mongoosePaginate as any);

// Indexes for performance
VideoSchema.index({ user: 1, createdAt: -1 }); // User's videos
VideoSchema.index({ isBoosted: 1, boostScore: -1, createdAt: -1 }); // Boosted feed
VideoSchema.index({ processingStatus: 1, createdAt: -1 }); // Feed sorted by date
VideoSchema.index({ tags: 1 }); // Search by tags
// Additional production indexes
VideoSchema.index({ user: 1, processingStatus: 1, createdAt: -1 }); // User's videos by status
VideoSchema.index({ viewCount: -1, createdAt: -1 }); // Trending videos
VideoSchema.index({ hasRewardPool: 1, isBoosted: 1 }); // Reward-enabled videos
VideoSchema.index({ boostEndDate: 1, isBoosted: 1 }); // Expiring boosts cleanup
// 🔍 TEXT SEARCH INDEX (FOR SEARCH SYSTEM)
VideoSchema.index(
  {
    title: 'text',
    caption: 'text',
    description: 'text',
    tags: 'text',
  },
  { name: 'VideoTextSearch' },
);

