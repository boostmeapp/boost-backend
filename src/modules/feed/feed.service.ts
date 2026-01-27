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

  // 1️⃣ Get candidate videos (READY only)
  const videos = await this.videoModel
    .find({ processingStatus: 'ready' })
    .populate('user', 'firstName lastName profileImage')
    .lean();

  // 2️⃣ Rank videos
  const ranked = videos
    .map((video: any) => ({
      ...video,
      rankScore: this.calculateRankScore(video),
    }))
    .sort((a, b) => b.rankScore - a.rankScore);

  // 3️⃣ Mix boosted content (every 5th video)
  const boosted = ranked.filter((v) => v.isBoosted);
  const normal = ranked.filter((v) => !v.isBoosted);

  const mixed: any[] = [];
  let boostIndex = 0;

  for (let i = 0; i < normal.length; i++) {
    if (i % 5 === 0 && boosted[boostIndex]) {
      mixed.push(boosted[boostIndex++]);
    }
    mixed.push(normal[i]);
  }

  // 4️⃣ Pagination
  const paginated = mixed.slice(skip, skip + limit);

  // 5️⃣ Like status
  const videoIds = paginated.map((v) => v._id.toString());
  const likedMap = await this.likesService.hasUserLikedVideos(
    userId,
    videoIds,
  );

  const finalVideos = paginated.map((video) => ({
    ...video,
    hasLiked: likedMap.get(video._id.toString()) || false,
  }));

  return {
    docs: finalVideos,
    totalDocs: mixed.length,
    limit,
    page,
    totalPages: Math.ceil(mixed.length / limit),
    hasNextPage: page * limit < mixed.length,
    hasPrevPage: page > 1,
  };
}

}
