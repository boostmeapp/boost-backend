import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PaginateModel } from 'mongoose';
import { Video } from '../../database/schemas/video/video.schema';
import { LikesService } from '../likes/likes.service';

@Injectable()
export class FeedService {
  constructor(
    @InjectModel(Video.name) private videoModel: PaginateModel<Video>,
    private likesService: LikesService,
  ) {}

  /**
   * Simple feed: All videos are public
   * Boosted videos appear first (sorted by boost score), then regular videos (sorted by creation date)
   * Boosted videos stay boosted until reward pool is depleted (no end date)
   */
  async getPersonalizedFeed(userId: string, page: number = 1, limit: number = 20) {
    const skip = (page - 1) * limit;

    const videos = await this.videoModel.aggregate([
      // Stage 1: Match all videos (no processing status filter)
      // TODO: Add back processingStatus filter when video processing is implemented
      {
        $match: {},
      },

      // Stage 2: Add sorting score
      {
        $addFields: {
          // Boosted videos get high score, regular videos get 0
          // No date check - boost stays active until pool depleted
          sortScore: {
            $cond: [
              { $eq: ['$isBoosted', true] },
              '$boostScore', // Use boost score for boosted videos
              0, // Regular videos get 0
            ],
          },
        },
      },

      // Stage 3: Sort - boosted videos first (by boost score), then regular videos (by created date)
      {
        $sort: {
          sortScore: -1, // Boosted videos come first
          createdAt: -1, // Within each group, newest first
        },
      },

      // Stage 4: Populate user data
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },

      // Stage 5: Remove sensitive data
      {
        $project: {
          'user.password': 0,
          'user.refreshToken': 0,
          sortScore: 0,
        },
      },

      // Stage 6: Pagination
      { $skip: skip },
      { $limit: limit },
    ]);

    // Get total count for pagination
    const total = await this.videoModel.countDocuments({});

    // Add hasLiked status for each video
    const videoIds = videos.map((v) => v._id.toString());
    const likedMap = await this.likesService.hasUserLikedVideos(userId, videoIds);

    const videosWithLikeStatus = videos.map((video) => ({
      ...video,
      hasLiked: likedMap.get(video._id.toString()) || false,
    }));

    return {
      docs: videosWithLikeStatus,
      totalDocs: total,
      limit,
      page,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    };
  }
}
