import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

export enum ReportContentType {
  VIDEO = 'video',
  COMMENT = 'comment',
  USER = 'user',
}

export enum ReportReason {
  SPAM = 'spam',
  NUDITY = 'nudity',
  VIOLENCE = 'violence',
  HARASSMENT = 'harassment',
  HATE_SPEECH = 'hate_speech',
  SELF_HARM = 'self_harm',
  ILLEGAL = 'illegal',
  OTHER = 'other',
}

export enum ReportStatus {
  PENDING = 'pending', // awaiting review
  REVIEWING = 'reviewing',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

export enum ReportResolution {
  CONTENT_REMOVED = 'content_removed',
  USER_BANNED = 'user_banned',
  NO_ACTION = 'no_action',
}

@Schema({ timestamps: true, collection: 'reports' })
export class Report extends Document {
  // Who filed the report
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporter: Types.ObjectId;

  @Prop({ type: String, enum: ReportContentType, required: true, index: true })
  contentType: ReportContentType;

  // Id of the reported video / comment / user
  @Prop({ type: Types.ObjectId, required: true, index: true })
  contentId: Types.ObjectId;

  // Owner of the reported content (for fast moderation actions)
  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  targetUser?: Types.ObjectId;

  @Prop({ type: String, enum: ReportReason, required: true })
  reason: ReportReason;

  @Prop({ trim: true, maxlength: 1000 })
  details?: string;

  @Prop({
    type: String,
    enum: ReportStatus,
    default: ReportStatus.PENDING,
    index: true,
  })
  status: ReportStatus;

  @Prop({ type: String, enum: ReportResolution })
  resolution?: ReportResolution;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedBy?: Types.ObjectId;

  @Prop()
  reviewedAt?: Date;

  @Prop({ trim: true })
  adminNote?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
ReportSchema.plugin(mongoosePaginate as any);

// Oldest pending first — drives the 24h review SLA queue
ReportSchema.index({ status: 1, createdAt: 1 });
// Prevent duplicate open reports from the same user on the same content
ReportSchema.index(
  { reporter: 1, contentType: 1, contentId: 1, status: 1 },
);
