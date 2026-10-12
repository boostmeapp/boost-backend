import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Video, User, ModerationStatus } from 'src/database/schemas';
import { SearchType } from './dto';

/**
 * A term goes straight into a regular expression, so every character the user
 * typed has to be treated as a literal. Without this a lone "(" is a 500 and
 * ".*.*.*" is a denial-of-service shape.
 */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A row as Mongo hands it back: the shape is the projection, not the schema. */
export interface LeanRow {
  _id: Types.ObjectId;
  [key: string]: unknown;
}

interface Slice {
  rows: LeanRow[];
  hasMore: boolean;
}

export interface TrendingTag {
  tag: string;
  videos: number;
  views: number;
}

/** One result in the blended list, tagged so the client can tell them apart. */
export type SearchItem =
  | ({ type: 'user'; id: string } & Record<string, unknown>)
  | ({ type: 'video'; id: string } & Record<string, unknown>);

export interface SearchResult {
  query: string;
  page: number;
  limit: number;
  items: SearchItem[];
  counts: { users: number; videos: number };
  hasMore: boolean;
  hasMoreUsers: boolean;
  hasMoreVideos: boolean;
}

// How a blended page is split. Fixed rather than relevance-driven because text
// scores from two different collections are not comparable — ranking one
// against the other would be inventing a number. A fixed share also makes
// paging deterministic: page N is always the same slice of each collection.
const USER_SHARE = 0.25;

const EMPTY = (query: string, page: number, limit: number): SearchResult => ({
  query,
  page,
  limit,
  items: [],
  counts: { users: 0, videos: 0 },
  hasMore: false,
  hasMoreUsers: false,
  hasMoreVideos: false,
});

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  /**
   * People and videos in one paginated list.
   *
   * Matching is by regular expression rather than MongoDB's `$text`, because
   * `$text` only matches whole stemmed words: typing "alex" finds nothing for
   * "alexbrad", which is exactly the behaviour a search-as-you-type box must
   * have. The cost is that a non-anchored expression cannot use an index, so
   * this scans; see the note on `searchUsers` below.
   */
  async search(
    args: { q: string; type?: SearchType; page?: number; limit?: number },
    viewerId?: string,
  ): Promise<SearchResult> {
    const query = (args.q || '').trim();
    const page = Math.max(1, args.page || 1);
    const limit = Math.min(50, Math.max(1, args.limit || 20));
    const type = args.type || 'all';

    // One character matches most of the collection and tells the user nothing.
    if (query.length < 2) return EMPTY(query, page, limit);

    // Who the viewer has blocked, plus the viewer: neither belongs in results.
    const hidden = await this.hiddenUserIds(viewerId);

    const userSlots =
      type === 'users'
        ? limit
        : type === 'videos'
          ? 0
          : Math.max(1, Math.round(limit * USER_SHARE));
    const videoSlots = limit - userSlots;

    const empty: Slice = { rows: [], hasMore: false };

    const [users, videos] = await Promise.all([
      userSlots > 0 ? this.findUsers(query, page, userSlots, hidden) : empty,
      videoSlots > 0 ? this.findVideos(query, page, videoSlots, hidden) : empty,
    ]);

    // People first: someone typing a name is usually looking for the person,
    // and the client renders them as rows above the video grid either way.
    const items: SearchItem[] = [
      ...users.rows.map((u) => ({
        ...u,
        type: 'user' as const,
        id: String(u._id),
      })),
      ...videos.rows.map((v) => ({
        ...v,
        type: 'video' as const,
        id: String(v._id),
      })),
    ];

    return {
      query,
      page,
      limit,
      items,
      counts: { users: users.rows.length, videos: videos.rows.length },
      hasMore: users.hasMore || videos.hasMore,
      hasMoreUsers: users.hasMore,
      hasMoreVideos: videos.hasMore,
    };
  }

  /** The viewer and anyone they have blocked. */
  private async hiddenUserIds(viewerId?: string): Promise<Types.ObjectId[]> {
    if (!viewerId || !Types.ObjectId.isValid(viewerId)) return [];

    const viewer = await this.userModel
      .findById(viewerId)
      .select('blockedUsers')
      .lean();

    const blocked = ((viewer?.blockedUsers as Types.ObjectId[]) || []).slice();
    blocked.push(new Types.ObjectId(viewerId));

    return blocked;
  }

  /**
   * An exact handle beats a handle that starts with the term, which beats a
   * match anywhere — so typing "alex" puts @alex above @alexbrad above
   * @realalexfan, rather than ordering by follower count alone.
   */
  private async findUsers(
    query: string,
    page: number,
    limit: number,
    hidden: Types.ObjectId[],
  ): Promise<Slice> {
    const safe = escapeRegex(query);
    const anywhere = new RegExp(safe, 'i');
    const starts = new RegExp(`^${safe}`, 'i');
    const exact = new RegExp(`^${safe}$`, 'i');

    const match: Record<string, unknown> = {
      isBanned: { $ne: true },
      isActive: { $ne: false },
      $or: [
        { username: anywhere },
        { firstName: anywhere },
        { lastName: anywhere },
      ],
    };

    if (hidden.length) match._id = { $nin: hidden };

    // One extra row is the cheapest way to answer "is there another page?".
    const rows = await this.userModel
      .aggregate<LeanRow>([
        { $match: match },
        {
          $addFields: {
            rank: {
              $switch: {
                branches: [
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$username', ''] },
                        regex: exact,
                      },
                    },
                    then: 0,
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$username', ''] },
                        regex: starts,
                      },
                    },
                    then: 1,
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$firstName', ''] },
                        regex: starts,
                      },
                    },
                    then: 2,
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: { $ifNull: ['$lastName', ''] },
                        regex: starts,
                      },
                    },
                    then: 2,
                  },
                ],
                default: 3,
              },
            },
          },
        },
        // _id last so the order is total — without it, equal ranks can shuffle
        // between pages and a row appears twice or not at all.
        { $sort: { rank: 1, followerCount: -1, _id: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit + 1 },
        {
          $project: {
            username: 1,
            firstName: 1,
            lastName: 1,
            profileImage: 1,
            followerCount: 1,
            isVerified: 1,
          },
        },
      ])
      .exec();

    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /**
   * Title, caption, description and tags. Tags are matched on their own as
   * well, so "#dance" and "dance" find the same videos.
   */
  private async findVideos(
    query: string,
    page: number,
    limit: number,
    hidden: Types.ObjectId[],
  ): Promise<Slice> {
    const term = query.replace(/^#/, '');
    const anywhere = new RegExp(escapeRegex(term), 'i');

    const match: Record<string, unknown> = {
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
      $or: [
        { title: anywhere },
        { caption: anywhere },
        { description: anywhere },
        { tags: anywhere },
      ],
    };

    if (hidden.length) match.user = { $nin: hidden };

    const rows = (await this.videoModel
      .find(match)
      .sort({ boostScore: -1, viewCount: -1, createdAt: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .populate('user', 'firstName lastName profileImage username')
      .select(
        'title caption description tags thumbnailUrl rawVideoKey duration viewCount likeCount commentCount user createdAt',
      )
      .lean()) as unknown as LeanRow[];

    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /**
   * The tags people are actually posting under, most used first.
   *
   * Recent activity only, so the list reflects what is happening now rather
   * than one viral video from last year. If the window is too quiet to fill
   * the list it is topped up from all time — an almost-empty trending row is
   * worse than a slightly stale one.
   *
   * Returns fewer than `limit`, or nothing at all, when the data says so. The
   * caller is expected to hide the section rather than invent filler.
   */
  async trendingTags(limit = 6, windowDays = 30): Promise<TrendingTag[]> {
    const take = Math.min(20, Math.max(1, limit));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const pipeline = (match: Record<string, unknown>): PipelineStage[] => [
      { $match: match },
      { $unwind: '$tags' },
      // Tags are free text, so "Dance" and "dance" are one tag, and a stray
      // leading # from the composer is not a different tag either.
      {
        $project: {
          tag: {
            $trim: {
              input: { $toLower: '$tags' },
              chars: '# ',
            },
          },
          viewCount: 1,
        },
      },
      { $match: { tag: { $nin: ['', null] } } },
      {
        $group: {
          _id: '$tag',
          videos: { $sum: 1 },
          views: { $sum: { $ifNull: ['$viewCount', 0] } },
        },
      },
      { $sort: { videos: -1, views: -1, _id: 1 } },
      { $limit: take },
      { $project: { _id: 0, tag: '$_id', videos: 1, views: 1 } },
    ];

    const visible = {
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
      tags: { $exists: true, $ne: [] },
    };

    const recent = await this.videoModel
      .aggregate<TrendingTag>(
        pipeline({ ...visible, createdAt: { $gte: since } }),
      )
      .exec();

    if (recent.length >= take) return recent;

    const allTime = await this.videoModel
      .aggregate<TrendingTag>(pipeline(visible))
      .exec();

    // Recent first, then all-time fills the gap without repeating a tag.
    const seen = new Set(recent.map((t) => t.tag));
    return [...recent, ...allTime.filter((t) => !seen.has(t.tag))].slice(
      0,
      take,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Kept for the older endpoints until the app is off them.             */
  /* ------------------------------------------------------------------ */

  async searchVideos(query: string, page = 1, limit = 20): Promise<LeanRow[]> {
    const { rows } = await this.findVideos(query, page, limit, []);
    return rows;
  }

  async searchUsers(query: string, page = 1, limit = 20): Promise<LeanRow[]> {
    if (!query?.trim()) return [];
    const { rows } = await this.findUsers(query.trim(), page, limit, []);
    return rows;
  }

  /** The shape the current app expects from GET /search/global. */
  async globalSearch(query: string, page = 1, limit = 12) {
    const result = await this.search({ q: query, page, limit, type: 'all' });

    return {
      users: result.items.filter((i) => i.type === 'user'),
      videos: result.items.filter((i) => i.type === 'video'),
    };
  }
}
