import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('conversations')
  async getConversations(
    @CurrentUser() user: User,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('isArchived') isArchived?: string,
  ) {
    return this.chatService.getUserConversations(
      user._id.toString(),
      Number(page),
      Number(limit),
      isArchived === 'true',
    );
  }

  @Patch('conversations/:conversationId/archive')
  async toggleArchiveConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
  ) {
    return this.chatService.toggleArchiveConversation(
      conversationId,
      user._id.toString(),
    );
  }

  @Get('messages/:conversationId')
  async getMessages(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.chatService.getMessages(
      conversationId,
      user._id.toString(),
      Number(page),
      Number(limit),
    );
  }

  @Post('start/:recipientId')
  async startConversation(
    @CurrentUser() user: User,
    @Param('recipientId') recipientId: string,
  ) {
    return this.chatService.getOrCreateConversation(
      user._id.toString(),
      recipientId,
    );
  }

  @Patch('read/:conversationId')
  async markAsRead(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
  ) {
    return this.chatService.markAsRead(
      conversationId,
      user._id.toString(),
    );
  }

  @Patch('messages/:messageId')
  async editMessage(
    @CurrentUser() user: User,
    @Param('messageId') messageId: string,
    @Body('text') text: string,
  ) {
    return this.chatService.editMessage(
      messageId,
      user._id.toString(),
      text,
    );
  }

  @Delete('messages/:messageId')
  async deleteMessage(
    @CurrentUser() user: User,
    @Param('messageId') messageId: string,
  ) {
    return this.chatService.deleteMessage(
      messageId,
      user._id.toString(),
    );
  }

  @Delete('conversations/:conversationId')
  async deleteConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
  ) {
    return this.chatService.deleteConversation(
      conversationId,
      user._id.toString(),
    );
  }
}
