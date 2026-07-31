import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private connectedUsers: Map<string, string> = new Map(); // userId -> socketId

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '') ||
        client.handshake.query?.token;

      if (!token) {
        this.logger.warn(`Client connection rejected: No token provided (${client.id})`);
        client.disconnect();
        return;
      }

      const secret = this.configService.get<string>('JWT_SECRET') || 'secretKey';
      const payload = this.jwtService.verify(token, { secret });
      const userId = payload.sub || payload.userId || payload.id || payload._id;

      if (!userId) {
        client.disconnect();
        return;
      }

      client.data.userId = userId.toString();
      this.connectedUsers.set(userId.toString(), client.id);

      // Join user's personal room for direct notifications
      client.join(`user_${userId}`);
      this.logger.log(`User connected to Chat Gateway: ${userId} (Socket ${client.id})`);
    } catch (err) {
      this.logger.error(`Connection authentication failed: ${err.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data?.userId) {
      this.connectedUsers.delete(client.data.userId);
      this.logger.log(`User disconnected from Chat Gateway: ${client.data.userId}`);
    }
  }

  @SubscribeMessage('joinConversation')
  handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    if (data?.conversationId) {
      client.join(`conv_${data.conversationId}`);
      this.logger.log(`Socket ${client.id} joined room conv_${data.conversationId}`);
    }
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      recipientId: string;
      text: string;
      image?: string;
    },
  ) {
    const senderId = client.data.userId;
    if (!senderId || !data.conversationId || !data.recipientId) {
      return;
    }

    const message = await this.chatService.createMessage(
      senderId,
      data.recipientId,
      data.conversationId,
      data.text,
      data.image,
    );

    // Emit to conversation room
    this.server.to(`conv_${data.conversationId}`).emit('newMessage', message);

    // Emit notification to recipient's personal room (for conversation list update & badges)
    this.server.to(`user_${data.recipientId}`).emit('conversationUpdated', {
      conversationId: data.conversationId,
      lastMessage: message,
    });
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; recipientId: string },
  ) {
    const senderId = client.data.userId;
    if (data?.conversationId) {
      client.to(`conv_${data.conversationId}`).emit('userTyping', {
        userId: senderId,
        conversationId: data.conversationId,
      });
    }
  }

  @SubscribeMessage('stopTyping')
  handleStopTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; recipientId: string },
  ) {
    const senderId = client.data.userId;
    if (data?.conversationId) {
      client.to(`conv_${data.conversationId}`).emit('userStopTyping', {
        userId: senderId,
        conversationId: data.conversationId,
      });
    }
  }

  @SubscribeMessage('markAsRead')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const userId = client.data.userId;
    if (userId && data?.conversationId) {
      await this.chatService.markAsRead(data.conversationId, userId);
      this.server.to(`conv_${data.conversationId}`).emit('messagesRead', {
        conversationId: data.conversationId,
        readBy: userId,
      });
    }
  }
}
