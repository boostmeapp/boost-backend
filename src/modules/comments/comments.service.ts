import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Video } from 'src/database/schemas';
import { CommentLike } from '../../database/schemas/comment-like/comment-like.schema';
import {
  Report,
  ReportContentType,
  ReportStatus,
} from '../../database/schemas/report/report.schema';
import { Comment } from './comment.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
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

  async create(userId: string, dto: CreateCommentDto) {
    // Content filter: reject objectionable language in comments
    if (!scanText(dto.content).clean) {
      throw new BadRequestException(
        'Your comment contains language that violates our Community Guidelines.',
      );
    }

    const video = await this.videoModel.findById(dto.videoId);
    if (!video) throw new NotFoundException('Video not found');

    const comment = await this.commentModel.create({
      video: dto.videoId,
      user: userId,
      parentComment: dto.parentCommentId || null,
      content: dto.content,
    });

    // Atomic increment
    await this.videoModel.updateOne(
      { _id: dto.videoId },
      { $inc: { commentCount: 1 } },
    );

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
    .populate('user', 'firstName lastName')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return this.withUserState(comments, userId);
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
      parentComment: commentId,
      isDeleted: false,
      isRemoved: false,
    })
    .populate('user', 'firstName lastName')
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

  const repliesCount = await this.commentModel.countDocuments({
    parentComment: comment._id,
    isDeleted: false,
  });

  await this.commentModel.updateMany(
    {
      $or: [{ _id: comment._id }, { parentComment: comment._id }],
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
