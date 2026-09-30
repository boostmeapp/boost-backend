import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { Conversation, ConversationSchema } from '../../database/schemas/chat/conversation.schema';
import { Message, MessageSchema } from '../../database/schemas/chat/message.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { UploadModule } from '../upload/upload.module';
import { NotificationModule } from '../notification/notification.module';
import { ChatPresenceService } from './chat-presence.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: User.name, schema: UserSchema },
    ]),
    JwtModule.register({}),
    ConfigModule,
    UploadModule,
    // New messages push to a recipient whose app is closed.
    NotificationModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ChatPresenceService],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
