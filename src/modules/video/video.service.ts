import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Video, VideoProcessingStatus, ModerationStatus } from '../../database/schemas/video/video.schema';
import { Boost, BoostStatus } from '../../database/schemas/boost/boost.schema';
import { CreateVideoDto, UpdateVideoDto } from './dto';
import { LikesService } from '../likes/likes.service';
import { FollowsService } from '../follows/follows.service';
import { scanText } from '../../common/utils/content-filter.util';
import { MediaUrlService } from '../../common/services/media-url.service';


@Injectable()
export class VideoService {
  constructor(
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(Boost.name) private boostModel: Model<Boost>,
    private readonly likesService: LikesService,
    private readonly followsService: FollowsService,
    private readonly mediaUrl: MediaUrlService,
  ) { }


  /**
   * Create a new video record (all videos are public)
   */
  async create(userId: string, dto: CreateVideoDto): Promise<Video> {
    // Content filter: reject objectionable text in title/caption/description/tags
    const scan = scanText(
      dto.title,
      dto.caption,
      dto.description,
      ...(dto.tags || []),
    );
    if (!scan.clean) {
      throw new BadRequestException(
        'Your post contains language that violates our Community Guidelines and cannot be published.',
      );
    }

    const video = new this.videoModel({
      user: new Types.ObjectId(userId),
      title: dto.title,
      description: dto.description,
      caption: dto.caption,
      tags: dto.tags?.map(t => t.trim().toLowerCase()) || [],
      rawVideoKey: dto.rawVideoKey,
      thumbnailUrl: dto.thumbnailUrl || '',
      thumbnailKey: dto.thumbnailKey,
      duration: dto.duration,
      processingStatus: VideoProcessingStatus.READY,
      processingProgress: 100,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
    });

    return video.save();
  }



  // Removed: getFollowingFeed / getFollowingFeedCursor — superseded by FeedService, called by nothing.

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
    const query: any = {
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    };

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
        .sort({
          isBoosted: -1,
          boostScore: -1,
          createdAt: -1,
        })
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
  async findOne(id: string, viewerId?: string): Promise<any> {

    const video = await this.videoModel
      .findById(id)
      .populate('user', 'email firstName lastName username profileImage')
      .lean();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    // Hide content removed by moderation from everyone except its owner.
    if (
      video.moderationStatus === ModerationStatus.REMOVED &&
      (!viewerId || video.user._id.toString() !== viewerId)
    ) {
      throw new NotFoundException('Video not found');
    }

    let hasLiked = false;
    let isFollowing = false;

    if (viewerId) {

      // Like Status
      hasLiked = await this.likesService.hasUserLikedVideo(viewerId, id);

      // Follow Status (viewer -> creator)
      isFollowing = await this.followsService.isFollowing(
        viewerId,
        video.user._id.toString(),
      );
    }

    return {
      ...video,
      // Absolute and playable, matching the feed contract.
      videoUrl: this.mediaUrl.toUrl(video.rawVideoKey),
      thumbnailUrl: this.mediaUrl.toUrl(
        (video as any).thumbnailKey || video.thumbnailUrl,
      ),
      hasLiked,
      isFollowing,
    };
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
  async remove(id: string, userId: string): Promise<{ message: string }> {
    const video = await this.videoModel.findById(id).exec();

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.user.toString() !== userId) {
      throw new ForbiddenException('You can only delete your own videos');
    }

    await this.videoModel.findByIdAndDelete(id).exec();
    return { message: 'Video deleted successfully' }
  }

  /**
   * Increment view count for video & active boost
   */
  async incrementViewCount(id: string): Promise<void> {
    await Promise.all([
      this.videoModel.findByIdAndUpdate(id, {
        $inc: { viewCount: 1 },
      }).exec(),
      this.boostModel.updateMany(
        { video: new Types.ObjectId(id), status: BoostStatus.ACTIVE },
        { $inc: { currentViews: 1 } },
      ).exec(),
    ]);
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

  async getProfileVideos(
    userId: string,
    page = 1,
    limit = 12,
  ) {
    const skip = (page - 1) * limit;

    const query = {
      user: new Types.ObjectId(userId),
      processingStatus: VideoProcessingStatus.READY,
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    };

    const [videos, total] = await Promise.all([
      this.videoModel
        .find(query)
        .select('thumbnailUrl videoUrl duration viewCount views likes createdAt')
        .sort({
          isBoosted: -1,
          boostScore: -1,
          createdAt: -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.videoModel.countDocuments(query),
    ]);

    return {
      data: videos,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
      },
    };
  }

}
