import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { StreamVideoService } from './stream-video.service';
import { CallService } from './call.service';
import { CallAuthorizationService } from './call-authorization.service';
import { CallController } from './call.controller';
import { CallWebhookController } from './call-webhook.controller';
import { CallWebhookService } from './call-webhook.service';
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

// RedisService comes from the global RedisModule.
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: User.name, schema: UserSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    // ChatService.isBlockedBetween is the single source of truth for blocks.
    ChatModule,
  ],
  controllers: [CallController, CallWebhookController],
  providers: [StreamVideoService, CallService, CallAuthorizationService, CallWebhookService],
  exports: [StreamVideoService, CallService, CallAuthorizationService],
})
export class CallModule {}
