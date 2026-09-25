import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, Video } from 'src/database/schemas';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { BoostEngagementService } from '../boost-campaigns/boost-engagement.service';
import { CommentLike } from '../../database/schemas/comment-like/comment-like.schema';
import {
  Report,
  ReportContentType,
  ReportStatus,
} from '../../database/schemas/report/report.schema';
import { Comment } from './comment.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
import { displayName } from '../../common/utils/display-name.util';
import { CommentResponse } from './interfaces/comment.interface';
import { CommentWithVideoUser } from './types/comment-populated.type';
import { scanText } from '../../common/utils/content-filter.util';

@Injectable()
export class CommentsService {
  constructor(
    @InjectModel(Comment.name) private commentModel: Model<Comment>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(CommentLike.name)
    private commentLikeModel: Model<CommentLike>,
    @InjectModel(Report.name) private reportModel: Model<Report>,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly notificationService: NotificationService,
    private readonly boostEngagement: BoostEngagementService,
  ) {}

  /**
   * Toggle the current user's like on a comment. likeCount on the comment is a
   * denormalised mirror of the CommentLike collection, updated in the same step.
   */
  async toggleLike(
    userId: string,
    commentId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    if (!Types.ObjectId.isValid(commentId)) {
      throw new NotFoundException('Invalid comment id');
    }

    const comment = await this.commentModel
      .findOne({ _id: commentId, isDeleted: false, isRemoved: false })
      .select('_id')
      .lean();

    if (!comment) throw new NotFoundException('Comment not found');

    const userObjectId = new Types.ObjectId(userId);
    const commentObjectId = new Types.ObjectId(commentId);

    const existing = await this.commentLikeModel.findOne({
      userId: userObjectId,
      commentId: commentObjectId,
    });

    if (existing) {
      await this.commentLikeModel.deleteOne({ _id: existing._id });
    } else {
      try {
        await this.commentLikeModel.create({
          userId: userObjectId,
          commentId: commentObjectId,
        });
      } catch (err: any) {
        // Unique index rejected a double-tap race; the like already exists.
        if (err?.code !== 11000) throw err;
      }
    }

    // Count the source of truth rather than $inc, so the mirror cannot drift.
    const likeCount = await this.commentLikeModel.countDocuments({
      commentId: commentObjectId,
    });

    await this.commentModel.updateOne(
      { _id: commentObjectId },
      { $set: { likeCount } },
    );

    return { liked: !existing, likeCount };
  }

  /** Which of these comments the user has an open report against. */
  private async reportedCommentIds(
    userId: string | undefined,
    commentIds: Types.ObjectId[],
  ): Promise<Set<string>> {
    if (!userId || !commentIds.length) return new Set();

    const reports = await this.reportModel
      .find({
        reporter: new Types.ObjectId(userId),
        contentType: ReportContentType.COMMENT,
        contentId: { $in: commentIds },
        status: { $in: [ReportStatus.PENDING, ReportStatus.REVIEWING] },
      })
      .select('contentId')
      .lean();

    return new Set(reports.map((r) => r.contentId.toString()));
  }

  /** Which of these comments the user has liked, as a set of id strings. */
  private async likedCommentIds(
    userId: string | undefined,
    commentIds: Types.ObjectId[],
  ): Promise<Set<string>> {
    if (!userId || !commentIds.length) return new Set();

    const likes = await this.commentLikeModel
      .find({
        userId: new Types.ObjectId(userId),
        commentId: { $in: commentIds },
      })
      .select('commentId')
      .lean();

    return new Set(likes.map((like) => like.commentId.toString()));
  }

  /** Tells the comment's author that someone replied. Errors are swallowed. */
  private async notifyReply(
    actorId: string,
    commentOwnerId: Types.ObjectId,
    video: any,
    content: string,
  ) {
    if (!commentOwnerId || String(commentOwnerId) === actorId) return;

    const actor = await this.userModel
      .findById(actorId)
      .select('firstName lastName username')
      .lean();

    const actorName = displayName(actor);

    void this.notificationService.notify({
      users: String(commentOwnerId),
      actor: actorId,
      type: NotificationType.Comment,
      title: actorName,
      body: `${actorName} replied to your comment`,
      metadata: {
        videoId: String(video._id),
        preview: content.slice(0, 120),
      },
    });
  }

  /** Tells the video owner about a new comment. Errors are swallowed. */
  private async notifyComment(actorId: string, video: any, content: string) {
    if (!video?.user) return;

    const actor = await this.userModel
      .findById(actorId)
      .select('firstName lastName username')
      .lean();

    const actorName = displayName(actor);

    void this.notificationService.notify({
      users: String(video.user),
      actor: actorId,
      type: NotificationType.Comment,
      title: actorName,
      body: `${actorName} commented on your post`,
      metadata: {
        videoId: String(video._id),
        preview: content.slice(0, 120),
      },
    });
  }

  /**
   * `parentComment` is a Mixed path in this schema, so Mongoose does not cast
   * ids for it: older rows hold a string and newer ones an ObjectId. Matching
   * on both is the only way to see every reply.
   */
  private idForms(id: string | Types.ObjectId): (string | Types.ObjectId)[] {
    const text = String(id);
    const forms: (string | Types.ObjectId)[] = [text];
    if (Types.ObjectId.isValid(text)) forms.push(new Types.ObjectId(text));
    return forms;
  }

  async create(userId: string, dto: CreateCommentDto) {
    // Content filter: reject objectionable language in comments
    if (!scanText(dto.content).clean) {
      throw new BadRequestException(
        'Your comment contains language that violates our Community Guidelines.',
      );
    }

    const video = await this.videoModel.findById(dto.videoId);
    if (!video) throw new NotFoundException('Video not found');

    // Two levels only: replying to a reply attaches to its parent comment,
    // so a thread can never nest deeper than comment → replies.
    let parent: { _id: Types.ObjectId; user: Types.ObjectId } | null = null;
    if (dto.parentCommentId) {
      const target = await this.commentModel
        .findOne({ _id: dto.parentCommentId, isDeleted: false })
        .select('user parentComment')
        .lean();
      if (!target) throw new NotFoundException('Comment not found');

      const rootId = (target.parentComment
        ? new Types.ObjectId(String(target.parentComment))
        : target._id) as Types.ObjectId;
      const root =
        String(rootId) === String(target._id)
          ? target
          : await this.commentModel.findById(rootId).select('user').lean();
      if (!root) throw new NotFoundException('Comment not found');

      parent = { _id: rootId, user: root.user as Types.ObjectId };
    }

    const comment = await this.commentModel.create({
      video: dto.videoId,
      user: userId,
      parentComment: parent?._id ?? null,
      content: dto.content,
    });

    // Atomic increment
    await this.videoModel.updateOne(
      { _id: dto.videoId },
      { $inc: { commentCount: 1 } },
    );

    if (parent) void this.notifyReply(userId, parent.user, video, dto.content);
    else void this.notifyComment(userId, video, dto.content);
    void this.boostEngagement.onVideoEngagement(userId, String(dto.videoId), 'comments');

    return comment;
  }

async getVideoComments(
  videoId: string,
  page = 1,
  limit = 20,
  userId?: string,
): Promise<CommentResponse[]> {
  const comments = await this.commentModel
    .find({
      video: videoId,
      parentComment: null,
      isDeleted: false,
      isRemoved: false,
    })
    .populate('user', 'username firstName lastName profileImage')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const withState = await this.withUserState(comments, userId);
  return this.withReplyCounts(withState);
}

/** How many visible replies each comment has, for the "View replies" row. */
private async withReplyCounts(comments: any[]): Promise<CommentResponse[]> {
  if (!comments.length) return comments as CommentResponse[];

  const counts = await this.commentModel.aggregate<{
    _id: Types.ObjectId;
    count: number;
  }>([
    {
      $match: {
        parentComment: {
          $in: comments.flatMap((c) => this.idForms(c._id as Types.ObjectId)),
        },
        isDeleted: false,
        isRemoved: false,
      },
    },
    { $group: { _id: '$parentComment', count: { $sum: 1 } } },
  ]);

  const byParent = new Map(counts.map((c) => [String(c._id), c.count]));
  return comments.map((c) => ({
    ...c,
    replyCount: byParent.get(String(c._id)) || 0,
  })) as CommentResponse[];
}

/** Attach the requesting user's like and report state to a list of lean comments. */
private async withUserState(
  comments: any[],
  userId?: string,
): Promise<CommentResponse[]> {
  const ids = comments.map((c) => c._id as Types.ObjectId);
  const [liked, reported] = await Promise.all([
    this.likedCommentIds(userId, ids),
    this.reportedCommentIds(userId, ids),
  ]);

  return comments.map((c) => ({
    ...c,
    likeCount: c.likeCount || 0,
    isLiked: liked.has(c._id.toString()),
    isReported: reported.has(c._id.toString()),
  })) as unknown as CommentResponse[];
}


 async getReplies(commentId: string, userId?: string): Promise<CommentResponse[]> {
  const replies = await this.commentModel
    .find({
      parentComment: { $in: this.idForms(commentId) },
      isDeleted: false,
      isRemoved: false,
    })
    .populate('user', 'username firstName lastName profileImage')
    .sort({ createdAt: 1 })
    .lean();

  return this.withUserState(replies, userId);
}


async softDelete(commentId: string, userId: string) {
  if (!Types.ObjectId.isValid(commentId)) {
    throw new NotFoundException('Invalid comment id');
  }

  const comment = (await this.commentModel
    .findOne({ _id: commentId, isDeleted: false })
    .populate('video', 'user')
    .lean()) as CommentWithVideoUser | null;

  if (!comment) {
    throw new NotFoundException('Comment not found');
  }

  const isCommentOwner =
    comment.user.toString() === userId;

  const isVideoOwner =
    comment.video.user.toString() === userId;

  if (!isCommentOwner && !isVideoOwner) {
    throw new NotFoundException('Not allowed');
  }

  const replyForms = this.idForms(comment._id);

  const repliesCount = await this.commentModel.countDocuments({
    parentComment: { $in: replyForms },
    isDeleted: false,
  });

  await this.commentModel.updateMany(
    {
      $or: [{ _id: comment._id }, { parentComment: { $in: replyForms } }],
    },
    { $set: { isDeleted: true } },
  );

  await this.videoModel.updateOne(
    { _id: comment.video._id },
    { $inc: { commentCount: -(1 + repliesCount) } },
  );

  return { success: true };
}


}
