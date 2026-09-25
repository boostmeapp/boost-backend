import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bull';
import { StreamVideoService } from './stream-video.service';
import { CallService } from './call.service';
import { CallAuthorizationService } from './call-authorization.service';
import { CallController } from './call.controller';
import { CallWebhookController } from './call-webhook.controller';
import { CallWebhookService } from './call-webhook.service';
import { CallSweeperCron } from './call-sweeper.cron';
import { CallEventsService } from './call-events.service';
import { CallAbuseService } from './call-abuse.service';
import { CallMetricsService } from './call-metrics.service';
import { AdminCallController } from './admin-call.controller';
import { CallTimeoutProcessor } from './processors/call-timeout.processor';
import { CALL_QUEUE } from './call.constants';
import { ChatModule } from '../chat/chat.module';
import { Call, CallSchema } from '../../database/schemas/call/call.schema';
import {
  Conversation,
  ConversationSchema,
  Follow,
  FollowSchema,
  User,
  UserSchema,
} from '../../database/schemas';

// RedisService comes from the global RedisModule; the Bull root connection
// and ScheduleModule are configured in AppModule.
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: User.name, schema: UserSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    BullModule.registerQueue({ name: CALL_QUEUE }),
    // ChatService.isBlockedBetween is the single source of truth for blocks.
    ChatModule,
  ],
  controllers: [CallController, CallWebhookController, AdminCallController],
  providers: [
    StreamVideoService,
    CallService,
    CallAuthorizationService,
    CallWebhookService,
    CallEventsService,
    CallAbuseService,
    CallMetricsService,
    CallTimeoutProcessor,
    CallSweeperCron,
  ],
  exports: [StreamVideoService, CallService, CallAuthorizationService],
})
export class CallModule {}
