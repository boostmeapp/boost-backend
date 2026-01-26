import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Video } from 'src/database/schemas';
import { Comment } from './comment.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CommentResponse } from './interfaces/comment.interface';
import { CommentWithVideoUser } from './types/comment-populated.type';

@Injectable()
export class CommentsService {
  constructor(
    @InjectModel(Comment.name) private commentModel: Model<Comment>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
  ) {}

  async create(userId: string, dto: CreateCommentDto) {
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
): Promise<CommentResponse[]> {
  const comments = await this.commentModel
    .find({
      video: videoId,
      parentComment: null,
      isDeleted: false,
    })
    .populate('user', 'firstName lastName')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return comments as unknown as CommentResponse[];
}


 async getReplies(commentId: string): Promise<CommentResponse[]> {
  const replies = await this.commentModel
    .find({
      parentComment: commentId,
      isDeleted: false,
    })
    .populate('user', 'firstName lastName')
    .sort({ createdAt: 1 })
    .lean();

  return replies as unknown as CommentResponse[];
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
