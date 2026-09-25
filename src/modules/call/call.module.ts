import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { StreamVideoService } from './stream-video.service';
import { CallService } from './call.service';
import { CallAuthorizationService } from './call-authorization.service';
import { CallController } from './call.controller';
import { ChatModule } from '../chat/chat.module';
import { Call, CallSchema } from '../../database/schemas/call/call.schema';
import { Follow, FollowSchema, User, UserSchema } from '../../database/schemas';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: User.name, schema: UserSchema },
      { name: Follow.name, schema: FollowSchema },
    ]),
    // ChatService.isBlockedBetween is the single source of truth for blocks.
    ChatModule,
  ],
  controllers: [CallController],
  providers: [StreamVideoService, CallService, CallAuthorizationService],
  exports: [StreamVideoService, CallService, CallAuthorizationService],
})
export class CallModule {}
