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
import { FollowsService } from '../follows/follows.service';


@Injectable()
export class VideoService {
constructor(
  @InjectModel(Video.name) private videoModel: Model<Video>,
  private readonly likesService: LikesService,
  private readonly followsService: FollowsService,
) {}


  /**
   * Create a new video record (all videos are public)
   */
  async create(userId: string, dto: CreateVideoDto): Promise<Video> {
    const video = new this.videoModel({
      user: new Types.ObjectId(userId),
      title: dto.title,
      description: dto.description,
      caption: dto.caption,
      tags: dto.tags?.map(t => t.trim().toLowerCase()) || [],
      rawVideoKey: dto.rawVideoKey,
      thumbnailUrl: dto.thumbnailUrl,
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



async getFollowingFeed(
  currentUserId: string,
  page: number = 1,
  limit: number = 20,
) {
  // 1️⃣ Get following user IDs
 const followingIds = await this.followsService.getFollowingIds(currentUserId);

  console.log('FOLLOWING IDS:', followingIds);
  // 2️⃣ If user follows nobody → return empty but CONSISTENT response
  if (!followingIds || followingIds.length === 0) {
    return {
      data: [],
      pagination: {
        total: 0,
        page,
        limit,
        totalPages: 0,
        hasNextPage: false,
      },
    };
  }

  const skip = (page - 1) * limit;

  // 3️⃣ Fetch videos + count
  const [videos, total] = await Promise.all([
    this.videoModel
      .find({
        user: { $in: followingIds },
        processingStatus: VideoProcessingStatus.READY,
      })
      .populate('user', 'firstName lastName email')
      .sort({
        isBoosted: -1,
        boostScore: -1,
        createdAt: -1,
      })
      .skip(skip)
      .limit(limit)
      .lean(),

    this.videoModel.countDocuments({
      user: { $in: followingIds },
      processingStatus: VideoProcessingStatus.READY,
    }),
  ]);

  // 4️⃣ Return FINAL response (frontend compatible)
  return {
    data: videos,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
    },
  };
}

  async getFollowingFeedCursor(
    currentUserId: string,
    limit: number = 20,
    cursor?: string,
  ) {
    const followingIds = await this.followsService.getFollowingIds(currentUserId);

    if (followingIds.length === 0) {
      return {
        data: [],
        nextCursor: null,
      };
    }

    const query: any = {
      user: { $in: followingIds },
      processingStatus: VideoProcessingStatus.READY,
    };

    // Cursor condition
    // Cursor condition (STABLE + SAFE)
    if (cursor) {
      const cursorVideo = await this.videoModel
        .findById(cursor)
        .select('_id createdAt isBoosted boostScore')
        .lean();

      if (cursorVideo) {
        query.$or = [
          // Same boost state, lower score
          {
            isBoosted: cursorVideo.isBoosted,
            boostScore: { $lt: cursorVideo.boostScore },
          },

          // Same boost + score, older date
          {
            isBoosted: cursorVideo.isBoosted,
            boostScore: cursorVideo.boostScore,
            createdAt: { $lt: cursorVideo.createdAt },
          },

          // Same boost + score + date, lower _id
          {
            isBoosted: cursorVideo.isBoosted,
            boostScore: cursorVideo.boostScore,
            createdAt: cursorVideo.createdAt,
            _id: { $lt: cursorVideo._id },
          },
        ];

      }
    }

    const videos = await this.videoModel
      .find(query)
      .populate('user', 'firstName lastName email')
      .sort({
        isBoosted: -1,
        boostScore: -1,
        createdAt: -1,
        _id: -1,
      })
      .limit(limit + 1) // fetch one extra
      .lean();

  const hasNext = videos.length > limit;
if (hasNext) videos.pop();

// ✅ ADD HERE (LIKE STATUS)
const videoIds = videos.map(v => v._id.toString());
const likedMap = await this.likesService.hasUserLikedVideos(
  currentUserId,
  videoIds,
);

const enrichedVideos = videos.map(video => ({
  ...video,
  hasLiked: likedMap.get(video._id.toString()) || false,
}));

return {
  data: enrichedVideos,
  nextCursor: hasNext ? enrichedVideos[enrichedVideos.length - 1]._id : null,
};

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
 async findOne(id: string, viewerId?: string): Promise<any> {

  const video = await this.videoModel
    .findById(id)
    .populate('user', 'email firstName lastName username profileImage')
    .lean();

  if (!video) {
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

  async getProfileVideos(
    userId: string,
    page = 1,
    limit = 12,
  ) {
    const skip = (page - 1) * limit;

    const query = {
      user: new Types.ObjectId(userId),
      processingStatus: VideoProcessingStatus.READY,
    };

    const [videos, total] = await Promise.all([
      this.videoModel
        .find(query)
        .select('thumbnailUrl duration viewCount createdAt')
        .sort({ createdAt: -1 })
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
