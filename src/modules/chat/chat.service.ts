import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, Message, User } from '../../database/schemas';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<Conversation>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<Message>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * Helper to ensure an image URL is signed if it comes from private S3
   */
  private async signImageUrl(imagePath?: string): Promise<string> {
    if (!imagePath || typeof imagePath !== 'string') return '';
    const trimmed = imagePath.trim();
    if (!trimmed || trimmed === '[object Object]' || trimmed === 'null' || trimmed === 'undefined') return '';

    // If it already has an AWS Signature, return as is
    if (trimmed.includes('X-Amz-Signature=')) return trimmed;

    // Extract S3 key
    let key = trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parts = trimmed.split('.amazonaws.com/');
      if (parts.length > 1) {
        key = parts[1];
      } else {
        return trimmed; // external image URL
      }
    }

    key = key.replace(/^\//, '');
    if (!key || key === '[object Object]') return '';

    try {
      const { url } = await this.uploadService.generateDownloadUrl(key);
      return url;
    } catch (e) {
      return trimmed;
    }
  }

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
   * Get list of conversations for a user (Active or Archived)
   */
  async getUserConversations(userId: string, page = 1, limit = 20, isArchived = false) {
    const userObjectId = new Types.ObjectId(userId);
    const skip = (page - 1) * limit;

    const query: any = { participants: userObjectId };
    if (isArchived) {
      query.archivedBy = userObjectId;
    } else {
      query.archivedBy = { $ne: userObjectId };
    }

    const conversations = await this.conversationModel
      .find(query)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('participants', 'username firstName lastName name avatar profileImage isVerified')
      .exec();

    const conversationsWithSignedAvatars = await Promise.all(
      conversations.map(async (conv) => {
        const convObj = conv.toObject();
        if (convObj.participants && Array.isArray(convObj.participants)) {
          convObj.participants = await Promise.all(
            convObj.participants.map(async (p: any) => {
              if (p && typeof p === 'object') {
                if (p.profileImage) {
                  p.profileImage = await this.signImageUrl(p.profileImage);
                }
                if (p.avatar) {
                  p.avatar = await this.signImageUrl(p.avatar);
                }
              }
              return p;
            }),
          );
        }
        return convObj;
      }),
    );

    const total = await this.conversationModel.countDocuments(query);

    return {
      data: conversationsWithSignedAvatars,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Toggle archive status of a conversation for current user
   */
  async toggleArchiveConversation(conversationId: string, userId: string) {
    if (!Types.ObjectId.isValid(conversationId)) {
      throw new NotFoundException('Conversation not found');
    }

    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const userObjId = new Types.ObjectId(userId);
    const isArchived = (conversation.archivedBy || []).some(
      (id) => String(id) === String(userId),
    );

    if (isArchived) {
      await this.conversationModel.findByIdAndUpdate(conversationId, {
        $pull: { archivedBy: userObjId },
      });
    } else {
      await this.conversationModel.findByIdAndUpdate(conversationId, {
        $addToSet: { archivedBy: userObjId },
      });
    }

    return {
      success: true,
      conversationId,
      isArchived: !isArchived,
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

    const messagesWithSignedUrls = await Promise.all(
      messages.map(async (msg) => {
        const msgObj = msg.toObject();
        if (msgObj.image) {
          msgObj.image = await this.signImageUrl(msgObj.image);
        }
        if (msgObj.sender && typeof msgObj.sender === 'object') {
          if (msgObj.sender.profileImage) {
            msgObj.sender.profileImage = await this.signImageUrl(msgObj.sender.profileImage);
          }
          if (msgObj.sender.avatar) {
            msgObj.sender.avatar = await this.signImageUrl(msgObj.sender.avatar);
          }
        }
        return msgObj;
      }),
    );

    return {
      data: messagesWithSignedUrls.reverse(),
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
      .populate('sender', 'username firstName lastName name avatar profileImage')
      .exec();

    const resultObj: any = populatedMessage
      ? populatedMessage.toObject()
      : message.toObject();

    if (resultObj && resultObj.image) {
      resultObj.image = await this.signImageUrl(resultObj.image);
    }

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

    return resultObj;
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

  /**
   * Delete a message by ID
   */
  async deleteMessage(messageId: string, userId: string) {
    if (!Types.ObjectId.isValid(messageId)) {
      return { success: true, messageId };
    }

    const message = await this.messageModel.findById(messageId);
    if (!message) {
      return { success: true, messageId };
    }

    const currentUserIdStr = String(userId);
    const senderIdStr = String(message.sender);
    const recipientIdStr = String(message.recipient);

    if (currentUserIdStr !== senderIdStr && currentUserIdStr !== recipientIdStr) {
      throw new ForbiddenException('You cannot delete this message');
    }

    await this.messageModel.findByIdAndDelete(messageId);
    return { success: true, messageId, conversationId: message.conversation.toString() };
  }

  /**
   * Edit a message by ID
   */
  async editMessage(messageId: string, userId: string, text: string) {
    if (!text || !text.trim()) {
      throw new BadRequestException('Message text cannot be empty');
    }
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }

    const message = await this.messageModel.findById(messageId);
    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (String(message.sender) !== String(userId)) {
      throw new ForbiddenException('You can only edit your own messages');
    }

    message.text = text.trim();
    message.isEdited = true;
    await message.save();

    const populated = await this.messageModel
      .findById(messageId)
      .populate('sender', 'username firstName lastName name avatar profileImage')
      .lean();

    return { success: true, message: populated };
  }

  /**
   * Delete a conversation and all its messages
   */
  async deleteConversation(conversationId: string, userId: string) {
    if (!Types.ObjectId.isValid(conversationId)) {
      return { success: true, conversationId };
    }

    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation) {
      return { success: true, conversationId };
    }

    const currentUserIdStr = String(userId);
    const isParticipant = conversation.participants.some(
      (p) => String(p._id || p) === currentUserIdStr,
    );

    if (!isParticipant) {
      throw new ForbiddenException('You cannot delete this conversation');
    }

    await this.messageModel.deleteMany({ conversation: conversationId });
    await this.conversationModel.findByIdAndDelete(conversationId);

    return { success: true, conversationId };
  }
}
