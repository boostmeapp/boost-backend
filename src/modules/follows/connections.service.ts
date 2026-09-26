import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';

import { Follow } from '../../database/schemas/follow/follow.schema';
import { User } from '../../database/schemas/user/user.schema';
import { MediaUrlService } from '../../common/services/media-url.service';
import { displayName } from '../../common/utils/display-name.util';

/** One row of a followers / following / mutuals / suggested list. */
export interface ConnectionPerson {
  id: string;
  name: string;
  username: string | null;
  subtitle: string;
  avatar: string | null;
  followerCount: number;
  /** Does the viewer follow this person? */
  isFollowing: boolean;
  /** Does this person follow the viewer? */
  followsYou: boolean;
  isSelf: boolean;
}

export interface ConnectionPage {
  items: ConnectionPerson[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** Only the fields a row needs, so the lists stay cheap. */
const USER_FIELDS = {
  _id: 1,
  username: 1,
  firstName: 1,
  lastName: 1,
  profileImage: 1,
  followerCount: 1,
};

/** Banned, deactivated and deleted accounts never appear in a list. */
const VISIBLE_USER = { isActive: true, isBanned: { $ne: true } };

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectModel(Follow.name) private readonly followModel: Model<Follow>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly mediaUrl: MediaUrlService,
  ) {}

  /** People who follow `userId`. */
  async getFollowers(userId: string, viewerId: string | undefined, query: PageQuery) {
    const target = this.objectId(userId);

    return this.runFollowPipeline(
      { match: { following: target }, person: '$follower' },
      viewerId,
      query,
    );
  }

  /** People `userId` follows. */
  async getFollowing(userId: string, viewerId: string | undefined, query: PageQuery) {
    const target = this.objectId(userId);

    return this.runFollowPipeline(
      { match: { follower: target }, person: '$following' },
      viewerId,
      query,
    );
  }

  /**
   * People who follow `userId` and whom the viewer also follows — the
   * "Followed by Ahsan, Irshad and others" list on someone else's profile.
   */
  async getMutuals(userId: string, viewerId: string | undefined, query: PageQuery) {
    const target = this.objectId(userId);

    if (!viewerId || String(userId) === String(viewerId)) {
      return this.emptyPage(query);
    }

    return this.runFollowPipeline(
      {
        match: { following: target },
        person: '$follower',
        // Keep only the followers the viewer follows too.
        extra: [
          {
            $lookup: {
              from: 'follows',
              let: { person: '$follower' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$follower', this.objectId(viewerId)] },
                        { $eq: ['$following', '$$person'] },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: 'viewerFollows',
            },
          },
          { $match: { 'viewerFollows.0': { $exists: true } } },
        ],
      },
      viewerId,
      query,
    );
  }

  /**
   * Accounts to follow next: everyone the viewer does not follow yet, most
   * followed first. A guest gets the same list without the exclusions.
   */
  async getSuggested(viewerId: string | undefined, query: PageQuery): Promise<ConnectionPage> {
    const { page, limit, skip, search } = this.paging(query);

    const followingIds = viewerId ? await this.followingIds(viewerId) : [];
    const blocked = viewerId ? await this.blockedIds(viewerId) : [];

    const exclude = [...followingIds, ...blocked];
    if (viewerId) exclude.push(this.objectId(viewerId));

    const match: Record<string, any> = { ...VISIBLE_USER };
    if (exclude.length) match._id = { $nin: exclude };
    if (search) match.$or = this.searchClauses(search);

    const [rows, total] = await Promise.all([
      this.userModel
        .find(match)
        .select(USER_FIELDS)
        .sort({ followerCount: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(match),
    ]);

    return this.toPage(rows, viewerId, { page, limit, total });
  }

  /**
   * Tab counts plus the first few mutual faces, so a profile can draw its
   * header without asking for a whole page of rows.
   */
  async getSummary(userId: string, viewerId: string | undefined) {
    const target = this.objectId(userId);
    const isSelf = !!viewerId && String(viewerId) === String(userId);

    const [followers, following, mutualPreview] = await Promise.all([
      this.followModel.countDocuments({ following: target }),
      this.followModel.countDocuments({ follower: target }),
      isSelf ? this.emptyPage({ page: 1, limit: 3 }) : this.getMutuals(userId, viewerId, { page: 1, limit: 3 }),
    ]);

    return {
      followers,
      following,
      mutuals: { total: mutualPreview.total, items: mutualPreview.items },
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Followers, following and mutuals differ only in which side of the follow
   * row is the person and how the rows are narrowed, so they share one
   * pipeline: match follows, join the user, page, then decorate.
   */
  private async runFollowPipeline(
    shape: { match: Record<string, any>; person: string; extra?: PipelineStage[] },
    viewerId: string | undefined,
    query: PageQuery,
  ): Promise<ConnectionPage> {
    const { page, limit, skip, search } = this.paging(query);

    const pipeline: PipelineStage[] = [
      { $match: shape.match },
      ...((shape.extra ?? []) as PipelineStage[]),
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $lookup: {
          from: 'users',
          let: { person: shape.person },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$person'] }, ...VISIBLE_USER } },
            { $project: USER_FIELDS },
          ],
          as: 'user',
        },
      },
      { $unwind: '$user' },
    ];

    if (search) {
      pipeline.push({
        $match: { $or: this.searchClauses(search, 'user.') },
      });
    }

    pipeline.push({
      $facet: {
        items: [{ $skip: skip }, { $limit: limit }, { $replaceRoot: { newRoot: '$user' } }],
        total: [{ $count: 'value' }],
      },
    });

    const [result] = await this.followModel.aggregate(pipeline);
    const rows = result?.items ?? [];
    const total = result?.total?.[0]?.value ?? 0;

    return this.toPage(rows, viewerId, { page, limit, total });
  }

  /**
   * Turns user documents into rows, adding the two follow flags the buttons
   * need. Both come from one query each over the page's ids, never per row.
   */
  private async toPage(
    rows: any[],
    viewerId: string | undefined,
    meta: { page: number; limit: number; total: number },
  ): Promise<ConnectionPage> {
    const ids = rows.map((r) => r._id);

    const [followedByViewer, followingViewer] = await Promise.all([
      this.followEdges(viewerId, ids, 'following'),
      this.followEdges(viewerId, ids, 'follower'),
    ]);

    const items = rows.map((row) => {
      const id = String(row._id);
      const followsYou = followingViewer.has(id);

      return {
        id,
        name: displayName(row, 'Anonymous'),
        username: row.username ?? null,
        subtitle: followsYou ? 'Follows you' : 'Suggested for you',
        avatar: this.mediaUrl.toUrl(row.profileImage),
        followerCount: row.followerCount ?? 0,
        isFollowing: followedByViewer.has(id),
        followsYou,
        isSelf: !!viewerId && id === String(viewerId),
      };
    });

    return {
      items,
      page: meta.page,
      limit: meta.limit,
      total: meta.total,
      hasMore: meta.page * meta.limit < meta.total,
    };
  }

  /**
   * The ids in `ids` on the given side of a follow with the viewer on the
   * other side: `following` answers "the viewer follows them", `follower`
   * answers "they follow the viewer".
   */
  private async followEdges(
    viewerId: string | undefined,
    ids: Types.ObjectId[],
    side: 'follower' | 'following',
  ): Promise<Set<string>> {
    if (!viewerId || !ids.length) return new Set();

    const viewer = this.objectId(viewerId);
    const other = side === 'following' ? 'follower' : 'following';

    const edges = await this.followModel
      .find({ [other]: viewer, [side]: { $in: ids } })
      .select(side)
      .lean();

    return new Set(edges.map((e: any) => String(e[side])));
  }

  private async followingIds(viewerId: string): Promise<Types.ObjectId[]> {
    const rows = await this.followModel
      .find({ follower: this.objectId(viewerId) })
      .select('following')
      .lean();

    return rows.map((r: any) => r.following);
  }

  private async blockedIds(viewerId: string): Promise<Types.ObjectId[]> {
    const viewer: any = await this.userModel
      .findById(this.objectId(viewerId))
      .select('blockedUsers')
      .lean();

    return (viewer?.blockedUsers ?? []).map((id: any) => new Types.ObjectId(String(id)));
  }

  /** The search box matches a username or either half of a legacy full name. */
  private searchClauses(search: string, prefix = '') {
    const rx = new RegExp(this.escape(search), 'i');

    return [
      { [`${prefix}username`]: rx },
      { [`${prefix}firstName`]: rx },
      { [`${prefix}lastName`]: rx },
    ];
  }

  private escape(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private paging(query: PageQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));

    return { page, limit, skip: (page - 1) * limit, search: query.q?.trim() || '' };
  }

  private emptyPage(query: PageQuery): ConnectionPage {
    const { page, limit } = this.paging(query);
    return { items: [], page, limit, total: 0, hasMore: false };
  }

  private objectId(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid user id');
    }
    return new Types.ObjectId(id);
  }
}

interface PageQuery {
  page?: number;
  limit?: number;
  q?: string;
}
