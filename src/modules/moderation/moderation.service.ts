import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Report,
  ReportContentType,
  ReportStatus,
} from '../../database/schemas/report/report.schema';
import {
  Video,
  ModerationStatus,
} from '../../database/schemas/video/video.schema';
import { User } from '../../database/schemas/user/user.schema';
import { Comment } from '../comments/comment.schema';
import { CreateReportDto } from './dto/create-report.dto';

// Number of distinct reports after which content is auto-hidden pending review.
const AUTO_REMOVE_THRESHOLD = 5;

@Injectable()
export class ModerationService {
  constructor(
    @InjectModel(Report.name) private reportModel: Model<Report>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(Comment.name) private commentModel: Model<Comment>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  /**
   * File a report against a video, comment, or user.
   */
  async createReport(reporterId: string, dto: CreateReportDto) {
    const contentObjectId = new Types.ObjectId(dto.contentId);

    // Resolve the content + its owner, and verify it exists.
    let targetUserId: Types.ObjectId | undefined;

    if (dto.contentType === ReportContentType.VIDEO) {
      const video = await this.videoModel
        .findById(contentObjectId)
        .select('user')
        .lean();
      if (!video) throw new NotFoundException('Video not found');
      targetUserId = video.user as Types.ObjectId;
    } else if (dto.contentType === ReportContentType.COMMENT) {
      const comment = await this.commentModel
        .findById(contentObjectId)
        .select('user')
        .lean();
      if (!comment) throw new NotFoundException('Comment not found');
      targetUserId = comment.user as Types.ObjectId;
    } else {
      const user = await this.userModel
        .findById(contentObjectId)
        .select('_id')
        .lean();
      if (!user) throw new NotFoundException('User not found');
      targetUserId = contentObjectId;
    }

    if (targetUserId && targetUserId.toString() === reporterId) {
      throw new BadRequestException('You cannot report your own content');
    }

    // Block duplicate open reports from the same reporter.
    const existing = await this.reportModel.findOne({
      reporter: new Types.ObjectId(reporterId),
      contentType: dto.contentType,
      contentId: contentObjectId,
      status: { $in: [ReportStatus.PENDING, ReportStatus.REVIEWING] },
    });
    if (existing) {
      return { success: true, message: 'Report already submitted', report: existing };
    }

    const report = await this.reportModel.create({
      reporter: new Types.ObjectId(reporterId),
      contentType: dto.contentType,
      contentId: contentObjectId,
      targetUser: targetUserId,
      reason: dto.reason,
      details: dto.details,
      status: ReportStatus.PENDING,
    });

    await this.applyAutoModeration(dto.contentType, contentObjectId);

    return {
      success: true,
      message:
        'Thank you for your report. Our team reviews all reports within 24 hours.',
      report,
    };
  }

  /**
   * Increment report counters and auto-hide content past the threshold.
   */
  private async applyAutoModeration(
    contentType: ReportContentType,
    contentId: Types.ObjectId,
  ) {
    if (contentType === ReportContentType.VIDEO) {
      const video = await this.videoModel.findByIdAndUpdate(
        contentId,
        { $inc: { reportCount: 1 } },
        { new: true },
      );
      if (!video) return;
      if (
        video.reportCount >= AUTO_REMOVE_THRESHOLD &&
        video.moderationStatus !== ModerationStatus.REMOVED
      ) {
        video.moderationStatus = ModerationStatus.REMOVED;
        video.removedReason = 'Auto-hidden: exceeded report threshold (pending review)';
        video.removedAt = new Date();
        await video.save();
      } else if (video.moderationStatus === ModerationStatus.ACTIVE) {
        video.moderationStatus = ModerationStatus.FLAGGED;
        await video.save();
      }
    } else if (contentType === ReportContentType.COMMENT) {
      const comment = await this.commentModel.findByIdAndUpdate(
        contentId,
        { $inc: { reportCount: 1 } },
        { new: true },
      );
      if (!comment) return;
      if (comment.reportCount >= AUTO_REMOVE_THRESHOLD && !comment.isRemoved) {
        comment.isRemoved = true;
        comment.removedAt = new Date();
        await comment.save();
      }
    }
    // User reports are handled manually by an admin.
  }

  /**
   * Block another user. Their content is hidden from the blocker's feeds.
   */
  async blockUser(userId: string, targetUserId: string) {
    if (userId === targetUserId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const target = await this.userModel.findById(targetUserId).select('_id').lean();
    if (!target) throw new NotFoundException('User not found');

    await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $addToSet: { blockedUsers: new Types.ObjectId(targetUserId) } },
    );
    return { success: true, message: 'User blocked' };
  }

  async unblockUser(userId: string, targetUserId: string) {
    await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $pull: { blockedUsers: new Types.ObjectId(targetUserId) } },
    );
    return { success: true, message: 'User unblocked' };
  }

  async getBlockedUsers(userId: string) {
    const user = await this.userModel
      .findById(userId)
      .populate('blockedUsers', 'firstName lastName username profileImage')
      .select('blockedUsers')
      .lean();
    return user?.blockedUsers || [];
  }

  /**
   * Helper used by feeds: list of user ids whose content `userId` should not see.
   */
  async getBlockedUserIds(userId: string): Promise<Types.ObjectId[]> {
    const user = await this.userModel
      .findById(userId)
      .select('blockedUsers')
      .lean();
    return (user?.blockedUsers as Types.ObjectId[]) || [];
  }
}
