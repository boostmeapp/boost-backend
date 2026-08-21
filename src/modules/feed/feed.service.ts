import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PaginateModel, Model } from 'mongoose';
import { Video, ModerationStatus } from '../../database/schemas/video/video.schema';
import { LikesService } from '../likes/likes.service';
import { Follow } from '../../database/schemas/follow/follow.schema';
import { User } from '../../database/schemas/user/user.schema';
import { Types } from 'mongoose';
import { MediaUrlService } from '../../common/services/media-url.service';
import { FeedQueryDto } from './dto';


@Injectable()
export class FeedService {
constructor(
  @InjectModel(Video.name) private videoModel: PaginateModel<Video>,
  @InjectModel(Follow.name) private followModel: PaginateModel<Follow>,
  @InjectModel(User.name) private userModel: Model<User>,
  private likesService: LikesService,
  private mediaUrl: MediaUrlService,
) {}

  /** Fields the mobile client actually reads. Everything else stays on the server. */
  private static readonly FEED_PROJECTION =
    'user title description tags likeCount commentCount shareCount viewCount ' +
    'duration rawVideoKey thumbnailUrl thumbnailKey isBoosted createdAt';

  private static readonly USER_PROJECTION =
    'firstName lastName username profileImage';

  private encodeCursor(v: any): string {
    return Buffer.from(
      `${new Date(v.createdAt).getTime()}_${v._id}`,
    ).toString('base64url');
  }

  private decodeCursor(
    cursor: string,
  ): { createdAt: Date; id: Types.ObjectId } | null {
    try {
      const [ts, id] = Buffer.from(cursor, 'base64url')
        .toString('utf8')
        .split('_');
      const millis = Number(ts);
      // Both halves must be present and well-formed, or the query silently returns an empty page.
      if (!ts || !id || !Number.isFinite(millis) || !Types.ObjectId.isValid(id)) {
        return null;
      }
      return { createdAt: new Date(millis), id: new Types.ObjectId(id) };
    } catch {
      return null; // a bad cursor is treated as "start from the beginning"
    }
  }

  /** Shapes one lean document into the wire format the app consumes. */
  private present(video: any, hasLiked: boolean) {
    return {
      _id: video._id,
      user: video.user,
      title: video.title,
      description: video.description,
      tags: video.tags,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      shareCount: video.shareCount,
      viewCount: video.viewCount,
      duration: video.duration,
      isBoosted: video.isBoosted,
      createdAt: video.createdAt,

      // Absolute and playable. The client no longer composes URLs.
      videoUrl: this.mediaUrl.toUrl(video.rawVideoKey),
      thumbnailUrl: this.mediaUrl.toUrl(video.thumbnailKey || video.thumbnailUrl),

      // Kept for one release so the currently-installed app keeps working.
      rawVideoKey: video.rawVideoKey,

      hasLiked,
    };
  }

  /** One keyset-or-offset paginator for both feeds. Cursor mode when `cursor` is supplied. */
  private async paginate(
    baseQuery: Record<string, any>,
    { page = 1, limit = 20, cursor }: FeedQueryDto,
    viewerId?: string,
  ) {
    const query: Record<string, any> = { ...baseQuery };
    const useCursor = Boolean(cursor);

    if (useCursor) {
      const c = this.decodeCursor(cursor!);
      if (c) {
        query.$and = [
          ...(query.$and || []),
          {
            $or: [
              { createdAt: { $lt: c.createdAt } },
              { createdAt: c.createdAt, _id: { $lt: c.id } },
            ],
          },
        ];
      }
    }

    const q = this.videoModel
      .find(query)
      .select(FeedService.FEED_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1) // +1 tells us if there is a next page
      .populate('user', FeedService.USER_PROJECTION)
      .lean();

    if (!useCursor) q.skip((page - 1) * limit);

    const rows = await q.exec();

    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop();

    let likedMap = new Map<string, boolean>();
    if (viewerId && rows.length) {
      likedMap = await this.likesService.hasUserLikedVideos(
        viewerId,
        rows.map(v => v._id.toString()),
      );
    }

    const docs = rows.map(v =>
      this.present(v, likedMap.get(v._id.toString()) || false),
    );

    return {
      docs,
      nextCursor:
        hasNextPage && rows.length
          ? this.encodeCursor(rows[rows.length - 1])
          : null,
      limit,
      page,
      hasNextPage,
      hasPrevPage: page > 1,

      // countDocuments() removed: it was a full index scan on every page request
      // and only fed hasNextPage, which limit+1 now answers exactly.
      totalDocs: null,
      totalPages: null,
    };
  }

// Ids of users the viewer has blocked — their content is hidden from feeds.
private async getBlockedUserIds(userId?: string): Promise<Types.ObjectId[]> {
  if (!userId) return [];
  const user = await this.userModel
    .findById(userId)
    .select('blockedUsers')
    .lean();
  return (user?.blockedUsers as Types.ObjectId[]) || [];
}

async getFollowingFeed(userId: string, query: FeedQueryDto) {
  const followingDocs = await this.followModel
    .find({ follower: new Types.ObjectId(userId) })
    .select('following')
    .lean();

  const followingIds = followingDocs.map(f => f.following);

  // ✅ If user follows nobody, return empty feed
  if (!followingIds.length) {
    return {
      docs: [],
      nextCursor: null,
      limit: query.limit ?? 20,
      page: query.page ?? 1,
      hasNextPage: false,
      hasPrevPage: false,
      totalDocs: 0,
      totalPages: 0,
    };
  }

  const blockedIds = await this.getBlockedUserIds(userId);
  const visibleFollowingIds = blockedIds.length
    ? followingIds.filter(
        id => !blockedIds.some(b => b.toString() === id.toString()),
      )
    : followingIds;

  return this.paginate(
    {
      user: { $in: visibleFollowingIds },
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    },
    query,
    userId,
  );
}

async getGlobalFeed(query: FeedQueryDto, userId?: string) {
  const blockedIds = await this.getBlockedUserIds(userId);

  const base: any = {
    processingStatus: 'ready',
    moderationStatus: { $ne: ModerationStatus.REMOVED },
  };
  if (blockedIds.length) {
    base.user = { $nin: blockedIds };
  }

  return this.paginate(base, query, userId);
}


  /**
   * TikTok-style feed
   * - All READY videos eligible
   * - Boosted videos get higher rank
   * - Boosted videos injected every N items
   * - Non-boosted videos from boosted users ALSO included
   * - No duplicate videos
   *
   * ⚠️ Wired to no route (D-36). Enabling it needs a precomputed, indexed rankScore —
   * as written it loads every ready video into memory on every request.
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

    const blockedIds = await this.getBlockedUserIds(userId);
    const baseQuery: any = {
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    };
    if (blockedIds.length) {
      baseQuery.user = { $nin: blockedIds };
    }

    /* 1️⃣ Fetch all READY videos */
    const videos = await this.videoModel
      .find(baseQuery)
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
