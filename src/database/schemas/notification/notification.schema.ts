import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

import {
  NotificationStatus,
  NotificationType,
} from '../../../modules/notification/notification.constants';

/**
 * One document per recipient.
 *
 * The BOE backend splits this into Notification + NotificationRecipient because
 * it sends broadcasts. Boostra's notifications are per-user (someone followed
 * you, liked your post), and the app reads them as a single per-user list, so a
 * flat document keeps the list query and the unread count to one collection.
 * `batchId` groups rows that came from one fan-out.
 */
@Schema({ timestamps: true, collection: 'notifications' })
export class Notification extends Document {
  /** Who receives it. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  /** Who caused it. Absent for system notifications. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  actor?: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(NotificationType),
    required: true,
    index: true,
  })
  type: NotificationType;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true, trim: true })
  body: string;

  /** Deep-link target, e.g. { videoId, commentId }. Sent in the FCM data payload. */
  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;

  @Prop({
    type: String,
    enum: Object.values(NotificationStatus),
    default: NotificationStatus.Scheduled,
    index: true,
  })
  status: NotificationStatus;

  @Prop({ default: false, index: true })
  isRead: boolean;

  @Prop()
  readAt?: Date;

  /** When the push was handed to FCM, not when the row was created. */
  @Prop()
  sentAt?: Date;

  /** Why a push did not go out — no tokens, notifications off, FCM error. */
  @Prop()
  failureReason?: string;

  /** Groups the rows produced by a single fan-out. */
  @Prop({ index: true })
  batchId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.plugin(mongoosePaginate as any);

// The app's list: newest first, per user.
NotificationSchema.index({ user: 1, createdAt: -1 });

// Unread badge count.
NotificationSchema.index({ user: 1, isRead: 1 });

// The "Boosts" filter tab.
NotificationSchema.index({ user: 1, type: 1, createdAt: -1 });
