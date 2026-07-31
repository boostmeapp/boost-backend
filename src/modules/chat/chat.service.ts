import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, Message, User } from '../../database/schemas';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<Conversation>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<Message>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  /**
   * Get or create a 1-on-1 conversation between two users
   */
  async getOrCreateConversation(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new ForbiddenException('Cannot start a chat with yourself');
    }

    const targetUser = await this.userModel.findById(targetUserId);
    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    const userA = new Types.ObjectId(currentUserId);
    const userB = new Types.ObjectId(targetUserId);

    let conversation = await this.conversationModel
      .findOne({
        participants: { $all: [userA, userB] },
      })
      .populate('participants', 'username firstName lastName name avatar profileImage isVerified');

    if (!conversation) {
      conversation = await this.conversationModel.create({
        participants: [userA, userB],
        unreadCount: new Map([
          [currentUserId, 0],
          [targetUserId, 0],
        ]),
      });

      conversation = await this.conversationModel
        .findById(conversation._id)
        .populate('participants', 'username firstName lastName name avatar profileImage isVerified');
    }

    return conversation;
  }

  /**
   * Get list of conversations for a user
   */
  async getUserConversations(userId: string, page = 1, limit = 20) {
    const userObjectId = new Types.ObjectId(userId);
    const skip = (page - 1) * limit;

    const conversations = await this.conversationModel
      .find({ participants: userObjectId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('participants', 'username firstName lastName name avatar profileImage isVerified')
      .exec();

    const total = await this.conversationModel.countDocuments({
      participants: userObjectId,
    });

    return {
      data: conversations,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get paginated message history for a conversation
   */
  async getMessages(conversationId: string, userId: string, page = 1, limit = 50) {
    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === userId,
    );
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this conversation');
    }

    const skip = (page - 1) * limit;

    const messages = await this.messageModel
      .find({ conversation: new Types.ObjectId(conversationId) })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('sender', 'username firstName lastName name avatar profileImage')
      .exec();

    const total = await this.messageModel.countDocuments({
      conversation: new Types.ObjectId(conversationId),
    });

    return {
      data: messages.reverse(),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Save a new message and update the conversation
   */
  async createMessage(
    senderId: string,
    recipientId: string,
    conversationId: string,
    text: string,
    image?: string,
  ) {
    const senderObj = new Types.ObjectId(senderId);
    const recipientObj = new Types.ObjectId(recipientId);
    const convObj = new Types.ObjectId(conversationId);

    const message = await this.messageModel.create({
      conversation: convObj,
      sender: senderObj,
      recipient: recipientObj,
      text: text || '',
      image: image || '',
      isRead: false,
    });

    // Populate sender info
    const populatedMessage = await this.messageModel
      .findById(message._id)
      .populate('sender', 'username name avatar')
      .exec();

    // Update conversation last message & unread count
    const conversation = await this.conversationModel.findById(conversationId);
    if (conversation) {
      conversation.lastMessage = {
        text: text || (image ? '📷 Photo' : ''),
        sender: senderObj,
        createdAt: message.createdAt,
      };

      const currentUnread = conversation.unreadCount.get(recipientId) || 0;
      conversation.unreadCount.set(recipientId, currentUnread + 1);
      conversation.markModified('unreadCount');
      await conversation.save();
    }

    return populatedMessage;
  }

  /**
   * Mark all unread messages in a conversation as read for a user
   */
  async markAsRead(conversationId: string, userId: string) {
    await this.messageModel.updateMany(
      {
        conversation: new Types.ObjectId(conversationId),
        recipient: new Types.ObjectId(userId),
        isRead: false,
      },
      { $set: { isRead: true } },
    );

    const conversation = await this.conversationModel.findById(conversationId);
    if (conversation) {
      conversation.unreadCount.set(userId, 0);
      conversation.markModified('unreadCount');
      await conversation.save();
    }

    return { success: true };
  }
}
