import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Video, VideoProcessingStatus } from '../../database/schemas/video/video.schema';
import { CreateVideoDto, UpdateVideoDto } from './dto';
import { LikesService } from '../likes/likes.service';

@Injectable()
export class VideoService {
  constructor(
    @InjectModel(Video.name) private videoModel: Model<Video>,
    private readonly likesService: LikesService,
  ) {}

  /**
   * Create a new video record (all videos are public)
   */
  async create(userId: string, createVideoDto: CreateVideoDto): Promise<Video> {
    const video = new this.videoModel({
      user: new Types.ObjectId(userId),
      title: createVideoDto.title,
      description: createVideoDto.description,
      caption: createVideoDto.caption,
      tags: createVideoDto.tags || [],
      rawVideoKey: createVideoDto.rawVideoKey,
      thumbnailUrl: createVideoDto.thumbnailUrl,
      duration: createVideoDto.duration,
      processingStatus: VideoProcessingStatus.UPLOADING,
      processingProgress: 0,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
    });

    return video.save();
  }

  async findAll(
    page: number = 1,
    limit: number = 20,
    filters?: {
      userId?: string;
      processingStatus?: VideoProcessingStatus;
      isBoosted?: boolean;
    },
    currentUserId?: string,
  ) {
    const query: any = {};

    if (filters?.userId) {
      query.user = new Types.ObjectId(filters.userId);
    }

    if (filters?.processingStatus) {
      query.processingStatus = filters.processingStatus;
    }

    if (filters?.isBoosted !== undefined) {
      query.isBoosted = filters.isBoosted;
    }

    const skip = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      this.videoModel
        .find(query)
        .populate('user', 'email firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.videoModel.countDocuments(query).exec(),
    ]);

    // Add hasLiked status if user is authenticated
    let videosWithLikeStatus = videos;
    if (currentUserId) {
      const videoIds = videos.map((v) => v._id.toString());
      const likedMap = await this.likesService.hasUserLikedVideos(currentUserId, videoIds);

      videosWithLikeStatus = videos.map((video) => ({
        ...video.toObject(),
        hasLiked: likedMap.get(video._id.toString()) || false,
      })) as any;
    }

    return {
      data: videosWithLikeStatus,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Find a video by ID (all videos are public)
   */
  async findOne(id: string, userId?: string): Promise<any> {
    const video = await this.videoModel
      .findById(id)
      .populate('user', 'email firstName lastName')
      .exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    // Add hasLiked status if user is authenticated
    const videoObj = video.toObject();
    if (userId) {
      const hasLiked = await this.likesService.hasUserLikedVideo(userId, id);
      return { ...videoObj, hasLiked };
    }

    return videoObj;
  }

  /**
   * Update a video
   */
  async update(id: string, userId: string, updateVideoDto: UpdateVideoDto): Promise<Video> {
    const video = await this.videoModel.findById(id).exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.user.toString() !== userId) {
      throw new ForbiddenException('You can only update your own videos');
    }

    Object.assign(video, updateVideoDto);
    return video.save();
  }

  /**
   * Delete a video
   */
  async remove(id: string, userId: string): Promise<{message: string}> {
    const video = await this.videoModel.findById(id).exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.user.toString() !== userId) {
      throw new ForbiddenException('You can only delete your own videos');
    }

    await this.videoModel.findByIdAndDelete(id).exec();
   return {message: 'Video deleted successfully'}
  }

  /**
   * Increment view count
   */
  async incrementViewCount(id: string): Promise<void> {
    await this.videoModel.findByIdAndUpdate(id, {
      $inc: { viewCount: 1 },
    }).exec();
  }

  /**
   * Get user's videos
   */
  async getUserVideos(userId: string, page: number = 1, limit: number = 20, currentUserId?: string) {
    return this.findAll(page, limit, { userId }, currentUserId);
  }

  /**
   * Update processing status
   */
  async updateProcessingStatus(
    id: string,
    status: VideoProcessingStatus,
    progress?: number,
  ): Promise<Video> {
    const update: any = { processingStatus: status };

    if (progress !== undefined) {
      update.processingProgress = progress;
    }

    const video = await this.videoModel
      .findByIdAndUpdate(id, update, { new: true })
      .exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    return video;
  }

  /**
   * Toggle like on a video
   */
  async toggleLike(userId: string, videoId: string) {
    const video = await this.videoModel.findById(videoId).exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    const result = await this.likesService.toggleLike(userId, videoId);

    // Update the video's like count
    await this.videoModel.findByIdAndUpdate(videoId, {
      likeCount: result.likeCount,
    }).exec();

    return result;
  }
}
