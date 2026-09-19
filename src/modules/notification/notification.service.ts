import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bull';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { Notification } from '../../database/schemas/notification/notification.schema';
import { MediaUrlService } from '../../common/services/media-url.service';
import {
  BOOST_NOTIFICATION_TYPES,
  NotificationStatus,
  NotificationType,
  QueueJobs,
  Queues,
} from './notification.constants';
import { SendNotificationJob } from './notification.processor';

export interface NotifyInput {
  /** Recipient, or recipients for a fan-out. */
  users: string | string[];
  type: NotificationType;
  title: string;
  body: string;
  /** Who triggered it. Omit for system notifications. */
  actor?: string;
  /** Deep-link payload: { videoId, commentId, ... }. */
  metadata?: Record<string, any>;
}

export type NotificationFilter = 'all' | 'unread' | 'boosts';

/**
 * The entry point other modules use. Mirrors BOE's
 * InstantNotificationQueueService.addNotificationJob: persist first, enqueue
 * second, so the in-app list is authoritative and delivery is best-effort.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    @InjectQueue(Queues.InstantNotification)
    private readonly notificationQueue: Queue<SendNotificationJob>,
    private readonly mediaUrl: MediaUrlService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Producing                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Writes one row per recipient and queues a push for each.
   *
   * Never throws at the call site: a notification must not be able to fail the
   * action that caused it. A like still registers if the push cannot be queued.
   */
  async notify(input: NotifyInput): Promise<string[]> {
    const { users, type, title, body, actor, metadata } = input;

    const recipients = (Array.isArray(users) ? users : [users])
      .filter(Boolean)
      .map(String);

    if (!recipients.length) return [];

    // Nobody needs telling about their own action.
    const targets = actor
      ? recipients.filter((id) => id !== String(actor))
      : recipients;

    if (!targets.length) return [];

    const batchId = randomUUID();

    try {
      const docs = await this.notificationModel.insertMany(
        targets.map((userId) => ({
          user: new Types.ObjectId(userId),
          actor: actor ? new Types.ObjectId(actor) : undefined,
          type,
          title,
          body,
          metadata: metadata ?? {},
          status: NotificationStatus.Scheduled,
          batchId,
        })),
      );

      await Promise.all(
        docs.map((doc) =>
          this.notificationQueue.add(QueueJobs.SendNotification, {
            notificationId: String(doc._id),
          }),
        ),
      );

      this.logger.log(
        `Queued ${docs.length} ${type} notification(s), batch ${batchId}`,
      );

      return docs.map((d) => String(d._id));
    } catch (err: any) {
      this.logger.error(
        `Failed to queue ${type} notification: ${err?.message}`,
        err?.stack,
      );
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Reading                                                             */
  /* ------------------------------------------------------------------ */

  /** The app's notification list, newest first, offset-paginated. */
  async getUserNotifications(
    userId: string,
    filter: NotificationFilter = 'all',
    offset = 0,
    limit = 10,
  ) {
    const query: Record<string, any> = { user: new Types.ObjectId(userId) };

    if (filter === 'unread') query.isRead = false;
    if (filter === 'boosts') query.type = { $in: BOOST_NOTIFICATION_TYPES };

    const skip = Math.max(0, offset);

    const [items, total] = await Promise.all([
      this.notificationModel
        .find(query)
        // `_id` breaks createdAt ties so consecutive offsets never overlap or skip.
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate('actor', 'firstName lastName username profileImage')
        .lean(),
      this.notificationModel.countDocuments(query),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        actor: item.actor ? this.mediaUrl.toPublicUser(item.actor) : null,
      })),
      pagination: {
        offset: skip,
        limit,
        total,
        nextOffset: skip + items.length,
        hasNextPage: skip + items.length < total,
      },
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationModel.countDocuments({
      user: new Types.ObjectId(userId),
      isRead: false,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Mutating                                                            */
  /* ------------------------------------------------------------------ */

  async markAsRead(userId: string, notificationId: string) {
    await this.notificationModel.updateOne(
      { _id: notificationId, user: new Types.ObjectId(userId) },
      { isRead: true, readAt: new Date() },
    );

    return { success: true };
  }

  async markAllAsRead(userId: string) {
    const res = await this.notificationModel.updateMany(
      { user: new Types.ObjectId(userId), isRead: false },
      { isRead: true, readAt: new Date() },
    );

    return { success: true, updated: res.modifiedCount };
  }

  async remove(userId: string, notificationId: string) {
    await this.notificationModel.deleteOne({
      _id: notificationId,
      user: new Types.ObjectId(userId),
    });

    return { success: true };
  }

  async clearAll(userId: string) {
    const res = await this.notificationModel.deleteMany({
      user: new Types.ObjectId(userId),
    });

    return { success: true, deleted: res.deletedCount };
  }
}
