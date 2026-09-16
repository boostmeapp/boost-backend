import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Notification,
  NotificationSchema,
} from '../../database/schemas/notification/notification.schema';
import {
  DeviceToken,
  DeviceTokenSchema,
} from '../../database/schemas/notification/device-token.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationProcessor } from './notification.processor';
import { PushNotificationService } from './services/push-notification.service';
import { Queues } from './notification.constants';

/**
 * Global so any feature module (follows, likes, comments, coins) can inject
 * NotificationService without adding an import and risking a circular one.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: DeviceToken.name, schema: DeviceTokenSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({
      name: Queues.InstantNotification,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    PushNotificationService,
    NotificationProcessor,
  ],
  exports: [NotificationService, PushNotificationService],
})
export class NotificationModule {}
