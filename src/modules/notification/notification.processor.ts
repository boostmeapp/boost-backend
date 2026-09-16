import { Process, Processor, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Job } from 'bull';
import type { Model } from 'mongoose';

import { Notification } from '../../database/schemas/notification/notification.schema';
import { User } from '../../database/schemas/user/user.schema';
import { PushNotificationService } from './services/push-notification.service';
import {
  NotificationStatus,
  QueueJobs,
  Queues,
} from './notification.constants';

export interface SendNotificationJob {
  notificationId: string;
}

/**
 * Worker for the instant-notification queue.
 *
 * Equivalent to BOE's `processInstantNotificationQueue`, expressed with the
 * @nestjs/bull decorators this project already uses for payouts.
 *
 * The row is written before the job is enqueued, so the in-app list is correct
 * even if the push never goes out. This worker only attempts delivery and
 * records the outcome.
 */
@Processor(Queues.InstantNotification)
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly pushService: PushNotificationService,
  ) {}

  @Process(QueueJobs.SendNotification)
  async handleSendNotification(job: Job<SendNotificationJob>): Promise<void> {
    const { notificationId } = job.data ?? {};
    if (!notificationId) return;

    const notification = await this.notificationModel.findById(notificationId);

    if (!notification) {
      this.logger.warn(`Notification ${notificationId} no longer exists`);
      return;
    }

    // Already handled — a retry after a partial failure, or a duplicate job.
    if (notification.status === NotificationStatus.Sent) return;

    const userId = String(notification.user);

    // Respect the per-user opt-out before spending an FCM call.
    const recipient = await this.userModel
      .findById(userId)
      .select('notificationEnabled isActive isBanned')
      .lean();

    if (!recipient || recipient.isActive === false || recipient.isBanned) {
      await this.markSkipped(notification, 'recipient-unavailable');
      return;
    }

    if ((recipient as any).notificationEnabled === false) {
      await this.markSkipped(notification, 'notifications-disabled');
      return;
    }

    const result = await this.pushService.sendToUser(
      userId,
      notification.title,
      notification.body,
      notification.type,
      { ...notification.metadata, notificationId },
    );

    if (result.success) {
      notification.status = NotificationStatus.Sent;
      notification.sentAt = new Date();
      notification.failureReason = undefined;
    } else {
      // "No tokens" is not a failure worth alarming about — the user simply
      // has no device registered. The row still shows in the in-app list.
      const benign =
        result.failureReason === 'no-tokens' ||
        result.failureReason === 'firebase-disabled';

      notification.status = benign
        ? NotificationStatus.Skipped
        : NotificationStatus.Failed;
      notification.failureReason = result.failureReason;
    }

    await notification.save();
  }

  private async markSkipped(
    notification: Notification,
    reason: string,
  ): Promise<void> {
    notification.status = NotificationStatus.Skipped;
    notification.failureReason = reason;
    await notification.save();
  }

  @OnQueueCompleted()
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed on ${Queues.InstantNotification}`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `Job ${job?.id ?? 'unknown'} failed on ${Queues.InstantNotification}: ${err?.message}`,
    );
  }
}
