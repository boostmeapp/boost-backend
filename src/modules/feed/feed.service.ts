import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PaginateModel } from 'mongoose';
import { Video } from '../../database/schemas/video/video.schema';
import { LikesService } from '../likes/likes.service';
import { Follow } from 'src/database/schemas/follow/follow.schema';
import { Types } from 'mongoose';


@Injectable()
export class FeedService {
constructor(
  @InjectModel(Video.name) private videoModel: PaginateModel<Video>,
  @InjectModel(Follow.name) private followModel: PaginateModel<Follow>,
  private likesService: LikesService,
) {}

async getFollowingFeed(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const userObjectId = new Types.ObjectId(userId);

  const followingDocs = await this.followModel
    .find({ follower: userObjectId })
    .select('following')
    .lean();

  const followingIds = followingDocs.map(f => f.following);

  // ✅ If user follows nobody, return empty feed
  if (!followingIds.length) {
    return {
      docs: [],
      totalDocs: 0,
      limit,
      page,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
    };
  }

  const query = {
    user: { $in: followingIds },
    processingStatus: 'ready',
  };

  const totalDocs = await this.videoModel.countDocuments(query);

  const videos = await this.videoModel
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('user', 'firstName lastName profileImage')
    .lean();

  const videoIds = videos.map(v => v._id.toString());

  const likedMap = await this.likesService.hasUserLikedVideos(
    userId,
    videoIds,
  );

  const finalVideos = videos.map(video => ({
    ...video,
    hasLiked: likedMap.get(video._id.toString()) || false,
  }));

  return {
    docs: finalVideos,
    totalDocs,
    limit,
    page,
    totalPages: Math.ceil(totalDocs / limit),
    hasNextPage: page * limit < totalDocs,
    hasPrevPage: page > 1,
  };
}



async getGlobalFeed(page = 1, limit = 20, userId?: string) {
  const skip = (page - 1) * limit;

  const query = {
    processingStatus: 'ready',
  };

  const totalDocs = await this.videoModel.countDocuments(query);

  const videos = await this.videoModel
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('user', 'firstName lastName profileImage')
    .lean();

  // ✅ ADD LIKE STATUS
  let finalVideos = videos;

  if (userId) {
    const videoIds = videos.map(v => v._id.toString());

    const likedMap = await this.likesService.hasUserLikedVideos(
      userId,
      videoIds,
    );

    finalVideos = videos.map(video => ({
      ...video,
      hasLiked: likedMap.get(video._id.toString()) || false,
    }));
  } else {
    finalVideos = videos.map(video => ({
      ...video,
      hasLiked: false,
    }));
  }

  return {
    docs: finalVideos,
    totalDocs,
    limit,
    page,
    totalPages: Math.ceil(totalDocs / limit),
    hasNextPage: page * limit < totalDocs,
    hasPrevPage: page > 1,
  };
}


  /**
   * TikTok-style feed
   * - All READY videos eligible
   * - Boosted videos get higher rank
   * - Boosted videos injected every N items
   * - Non-boosted videos from boosted users ALSO included
   * - No duplicate videos
   */

  private calculateRankScore(video: any): number {
    const watchScore =
      video.viewCount > 0
        ? Math.min(
            video.watchTimeTotal / (video.viewCount * video.duration),
            1,
          )
        : 0;

    const engagementScore =
      video.viewCount > 0
        ? (video.likeCount +
            video.commentCount * 2 +
            video.shareCount * 3) /
          video.viewCount
        : 0;

    const hoursSinceUpload =
      (Date.now() - new Date(video.createdAt).getTime()) / 36e5;

    const freshnessScore = Math.exp(-hoursSinceUpload / 48);

    const boostScore = video.isBoosted ? video.boostScore / 100 : 0;

    return (
      watchScore * 0.4 +
      engagementScore * 0.3 +
      freshnessScore * 0.2 +
      boostScore * 0.1
    );
  }

  async getPersonalizedFeed(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    /* 1️⃣ Fetch all READY videos */
    const videos = await this.videoModel
      .find({ processingStatus: 'ready' })
      .populate('user', 'firstName lastName profileImage')
      .lean();

    /* 2️⃣ Rank all videos */
    const ranked = videos
      .map((video: any) => ({
        ...video,
        rankScore: this.calculateRankScore(video),
      }))
      .sort((a, b) => b.rankScore - a.rankScore);

    /* 3️⃣ Split boosted / normal (NO FILTERING OF USERS) */
    const boosted = ranked.filter(v => v.isBoosted);
    const normal = ranked.filter(v => !v.isBoosted);

    /* 4️⃣ Mix feed (1 boosted after every 5 normal) */
    const mixed: any[] = [];
    let boostIndex = 0;

    for (let i = 0; i < normal.length; i++) {
      if (i % 5 === 0 && boosted[boostIndex]) {
        mixed.push(boosted[boostIndex++]);
      }
      mixed.push(normal[i]);
    }

    /* 5️⃣ Append remaining boosted (if any) */
    while (boostIndex < boosted.length) {
      mixed.push(boosted[boostIndex++]);
    }

    /* 6️⃣ Remove duplicates (CRITICAL FIX) */
    const uniqueMap = new Map<string, any>();
    for (const video of mixed) {
      uniqueMap.set(video._id.toString(), video);
    }
    const uniqueFeed = Array.from(uniqueMap.values());

    /* 7️⃣ Pagination */
    const paginated = uniqueFeed.slice(skip, skip + limit);

    /* 8️⃣ Like status */
    const videoIds = paginated.map(v => v._id.toString());
    const likedMap = await this.likesService.hasUserLikedVideos(
      userId,
      videoIds,
    );

    const finalVideos = paginated.map(video => ({
      ...video,
      hasLiked: likedMap.get(video._id.toString()) || false,
    }));

    return {
      docs: finalVideos,
      totalDocs: uniqueFeed.length,
      limit,
      page,
      totalPages: Math.ceil(uniqueFeed.length / limit),
      hasNextPage: page * limit < uniqueFeed.length,
      hasPrevPage: page > 1,
    };
  }
}
