import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User } from '../../database/schemas/user/user.schema';
import {
  Video,
  ModerationStatus,
} from '../../database/schemas/video/video.schema';
import {
  Report,
  ReportContentType,
  ReportStatus,
  ReportResolution,
} from '../../database/schemas/report/report.schema';
import { Comment } from '../comments/comment.schema';
import { WalletService } from '../wallet/wallet.service';
import { TransactionService } from '../transaction/transaction.service';
import { BoostService } from '../boost/boost.service';
import { RewardService } from '../reward/reward.service';
import { TransactionStatus } from '../../database/schemas/transaction/transaction.schema';
import { BoostStatus } from '../../database/schemas/boost/boost.schema';
import { ResolveReportDto, ResolveAction } from './dto/resolve-report.dto';

// 24h review SLA per App Store Guideline 1.2
const SLA_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(Report.name) private reportModel: Model<Report>,
    @InjectModel(Comment.name) private commentModel: Model<Comment>,
    private walletService: WalletService,
    private transactionService: TransactionService,
    private boostService: BoostService,
    private rewardService: RewardService,
  ) {}

  async getAllUsers(): Promise<User[]> {
    return this.userModel.find().exec();
  }

  async deleteUser(userId: string): Promise<{ message: string }> {
    const user = await this.userModel.findById(userId).exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    await this.userModel.findByIdAndDelete(userId).exec();

    return {
      message: `User ${user.email} has been permanently deleted`,
    };
  }

  async toggleBanUser(userId: string): Promise<User> {
    const user = await this.userModel.findById(userId).exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const newBanStatus = !user.isBanned;

    const updatedUser = await this.userModel
      .findByIdAndUpdate(
        userId,
        {
          isBanned: newBanStatus,
          bannedAt: newBanStatus ? new Date() : null,
          isActive: !newBanStatus,
        },
        { new: true },
      )
      .exec();

    if (!updatedUser) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return updatedUser;
  }

  // Transaction management
  async getAllTransactions(limit: number) {
    return this.transactionService.getAllTransactions(limit);
  }

  async getTransactionsByStatus(status: TransactionStatus, limit: number) {
    return this.transactionService.getTransactionsByStatus(status, limit);
  }

  // Wallet management
  async getAllWallets() {
    return this.walletService.getAllWallets();
  }

  async lockWallet(userId: string, reason: string) {
    return this.walletService.lockWallet(userId, reason);
  }

  async unlockWallet(userId: string) {
    return this.walletService.unlockWallet(userId);
  }

  // Boost management
  async getAllBoosts(limit: number) {
    return this.boostService.getAllBoosts(limit);
  }

  async getBoostsByStatus(status: BoostStatus, limit: number) {
    return this.boostService.getBoostsByStatus(status, limit);
  }

  // Reward management
  async getAllUserBalances(limit: number) {
    return this.rewardService.getAllUserBalances(limit);
  }

  async getTopEarners(limit: number) {
    return this.rewardService.getTopEarners(limit);
  }

  async getGlobalRewardStats() {
    return this.rewardService.getGlobalRewardStats();
  }

  // ─────────────────────────────────────────────────────────────
  // CONTENT MODERATION
  // ─────────────────────────────────────────────────────────────

  /**
   * Report queue. Oldest pending first so the 24h SLA is honoured.
   */
  async getReports(status?: string, page = 1, limit = 50) {
    const query: any = {};
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      this.reportModel
        .find(query)
        .populate('reporter', 'firstName lastName username email')
        .populate('targetUser', 'firstName lastName username email isBanned')
        .sort({ createdAt: 1 }) // oldest first
        .skip(skip)
        .limit(limit)
        .lean(),
      this.reportModel.countDocuments(query),
    ]);

    const now = Date.now();
    const withMeta = reports.map((r: any) => ({
      ...r,
      isOverdue:
        r.status === ReportStatus.PENDING &&
        now - new Date(r.createdAt).getTime() > SLA_MS,
    }));

    return {
      data: withMeta,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
      },
    };
  }

  async getReportStats() {
    const slaCutoff = new Date(Date.now() - SLA_MS);
    const [pending, reviewing, resolved, dismissed, overdue] = await Promise.all([
      this.reportModel.countDocuments({ status: ReportStatus.PENDING }),
      this.reportModel.countDocuments({ status: ReportStatus.REVIEWING }),
      this.reportModel.countDocuments({ status: ReportStatus.RESOLVED }),
      this.reportModel.countDocuments({ status: ReportStatus.DISMISSED }),
      this.reportModel.countDocuments({
        status: ReportStatus.PENDING,
        createdAt: { $lt: slaCutoff },
      }),
    ]);
    return { pending, reviewing, resolved, dismissed, overdue };
  }

  /**
   * Resolve a report: remove the content, ban the owner, or dismiss.
   */
  async resolveReport(reportId: string, adminId: string, dto: ResolveReportDto) {
    const report = await this.reportModel.findById(reportId);
    if (!report) throw new NotFoundException('Report not found');

    const adminObjectId = new Types.ObjectId(adminId);
    let resolution: ReportResolution = ReportResolution.NO_ACTION;

    if (dto.action === ResolveAction.REMOVE_CONTENT) {
      await this.removeReportedContent(report);
      resolution = ReportResolution.CONTENT_REMOVED;
    } else if (dto.action === ResolveAction.BAN_USER) {
      if (!report.targetUser) {
        throw new BadRequestException('Report has no target user to ban');
      }
      await this.banUser(report.targetUser.toString());
      // Also remove the offending content
      await this.removeReportedContent(report);
      resolution = ReportResolution.USER_BANNED;
    } else {
      resolution = ReportResolution.NO_ACTION;
    }

    report.status =
      dto.action === ResolveAction.DISMISS
        ? ReportStatus.DISMISSED
        : ReportStatus.RESOLVED;
    report.resolution = resolution;
    report.reviewedBy = adminObjectId;
    report.reviewedAt = new Date();
    report.adminNote = dto.note;
    await report.save();

    return { success: true, report };
  }

  private async removeReportedContent(report: Report) {
    if (report.contentType === ReportContentType.VIDEO) {
      await this.videoModel.findByIdAndUpdate(report.contentId, {
        moderationStatus: ModerationStatus.REMOVED,
        removedReason: `Removed via report (${report.reason})`,
        removedAt: new Date(),
        removedBy: report.reviewedBy,
      });
    } else if (report.contentType === ReportContentType.COMMENT) {
      await this.commentModel.findByIdAndUpdate(report.contentId, {
        isRemoved: true,
        removedAt: new Date(),
      });
    }
  }

  private async banUser(userId: string) {
    await this.userModel.findByIdAndUpdate(userId, {
      isBanned: true,
      bannedAt: new Date(),
      isActive: false,
    });
  }

  // ── Post (video) management ──────────────────────────────────

  async getAllVideosAdmin(status?: string, page = 1, limit = 50) {
    const query: any = {};
    if (status) query.moderationStatus = status;

    const skip = (page - 1) * limit;
    const [videos, total] = await Promise.all([
      this.videoModel
        .find(query)
        .populate('user', 'firstName lastName username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.videoModel.countDocuments(query),
    ]);

    return {
      data: videos,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
      },
    };
  }

  async removeVideo(videoId: string, adminId: string, reason?: string) {
    const video = await this.videoModel.findByIdAndUpdate(
      videoId,
      {
        moderationStatus: ModerationStatus.REMOVED,
        removedReason: reason || 'Removed by admin',
        removedAt: new Date(),
        removedBy: new Types.ObjectId(adminId),
      },
      { new: true },
    );
    if (!video) throw new NotFoundException('Video not found');
    return { success: true, video };
  }

  async restoreVideo(videoId: string) {
    const video = await this.videoModel.findByIdAndUpdate(
      videoId,
      {
        moderationStatus: ModerationStatus.ACTIVE,
        removedReason: null,
        removedAt: null,
        removedBy: null,
      },
      { new: true },
    );
    if (!video) throw new NotFoundException('Video not found');
    return { success: true, video };
  }

  async removeComment(commentId: string) {
    const comment = await this.commentModel.findByIdAndUpdate(
      commentId,
      { isRemoved: true, removedAt: new Date() },
      { new: true },
    );
    if (!comment) throw new NotFoundException('Comment not found');
    return { success: true, comment };
  }

  // ── Dashboard ────────────────────────────────────────────────

  async getDashboardStats() {
    const slaCutoff = new Date(Date.now() - SLA_MS);
    const [
      totalUsers,
      bannedUsers,
      totalVideos,
      removedVideos,
      totalComments,
      pendingReports,
      overdueReports,
    ] = await Promise.all([
      this.userModel.countDocuments({}),
      this.userModel.countDocuments({ isBanned: true }),
      this.videoModel.countDocuments({}),
      this.videoModel.countDocuments({
        moderationStatus: ModerationStatus.REMOVED,
      }),
      this.commentModel.countDocuments({ isDeleted: false, isRemoved: false }),
      this.reportModel.countDocuments({ status: ReportStatus.PENDING }),
      this.reportModel.countDocuments({
        status: ReportStatus.PENDING,
        createdAt: { $lt: slaCutoff },
      }),
    ]);

    return {
      totalUsers,
      bannedUsers,
      totalVideos,
      removedVideos,
      totalComments,
      pendingReports,
      overdueReports,
    };
  }
}
