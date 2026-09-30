import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Model, Types } from 'mongoose';

import {
  Story,
  StoryMediaType,
  StoryStatus,
} from '../../database/schemas/story/story.schema';
import { User } from '../../database/schemas/user/user.schema';
import { StoryView } from '../../database/schemas/story/story-view.schema';
import { MediaUrlService } from '../../common/services/media-url.service';
import { displayName } from '../../common/utils/display-name.util';
import { ChatService } from '../chat/chat.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { ChatGateway } from '../chat/chat.gateway';
import { FollowsService } from '../follows/follows.service';
import { UploadService } from '../upload/upload.service';
import { CreateStoryDto, ShareStoryDto } from './dto';
import {
  ExpireStoryJob,
  MAX_STORY_VIDEO_SECONDS,
  STORY_IMAGE_PREFIXES,
  STORY_QUEUE,
  STORY_TTL_MS,
  STORY_VIDEO_PREFIX,
  StoryJobs,
} from './stories.constants';

/** Only these fields are ever needed to draw a story's author. */
const AUTHOR_FIELDS = '_id username firstName lastName profileImage';

@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    @InjectModel(Story.name) private readonly storyModel: Model<Story>,
    @InjectModel(StoryView.name) private readonly storyViewModel: Model<StoryView>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectQueue(STORY_QUEUE) private readonly storyQueue: Queue,
    private readonly follows: FollowsService,
    private readonly chat: ChatService,
    private readonly notifications: NotificationService,
    private readonly chatGateway: ChatGateway,
    private readonly uploadService: UploadService,
    private readonly mediaUrl: MediaUrlService,
  ) {}

  /* ---------- creation ---------- */

  async create(userId: string, dto: CreateStoryDto) {
    if (dto.mediaType === StoryMediaType.Video && !dto.durationSeconds) {
      throw new BadRequestException('A video story must report its duration');
    }

    if (
      dto.durationSeconds &&
      dto.durationSeconds > MAX_STORY_VIDEO_SECONDS
    ) {
      throw new BadRequestException(
        `A story can be at most ${MAX_STORY_VIDEO_SECONDS} seconds`,
      );
    }

    const prefixes =
      dto.mediaType === StoryMediaType.Video
        ? [STORY_VIDEO_PREFIX]
        : STORY_IMAGE_PREFIXES;

    await this.assertOwnedObject(userId, dto.mediaKey, prefixes);
    if (dto.thumbnailKey) {
      await this.assertOwnedObject(userId, dto.thumbnailKey, STORY_IMAGE_PREFIXES);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + STORY_TTL_MS);

    const story = await this.storyModel.create({
      user: new Types.ObjectId(userId),
      mediaType: dto.mediaType,
      mediaKey: dto.mediaKey,
      thumbnailKey: dto.thumbnailKey,
      durationSeconds: dto.durationSeconds,
      music: dto.music,
      status: StoryStatus.Active,
      expiresAt,
      viewCount: 0,
    });

    await this.scheduleExpiry(String(story._id), expiresAt);

    this.logger.log(
      `story ${story._id} created by ${userId} (${dto.mediaType}), expires ${expiresAt.toISOString()}`,
    );

    return this.serialise(story);
  }

  /**
   * One delayed job per story. The sweep in stories.cron covers anything the
   * queue loses, and every read filters on expiresAt regardless, so a missing
   * job can never leak an expired story into a feed.
   */
  private async scheduleExpiry(storyId: string, expiresAt: Date) {
    const delay = Math.max(0, expiresAt.getTime() - Date.now());

    try {
      await this.storyQueue.add(
        StoryJobs.Expire,
        { storyId } satisfies ExpireStoryJob,
        {
          delay,
          jobId: `expire:${storyId}`,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      // Redis being down must not cost the user their story.
      this.logger.error(
        `could not schedule expiry for story ${storyId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Flip one story to expired. Re-reads first and only acts while it is still
   * active and actually past its time, so it is safe to run twice or late.
   */
  async expire(storyId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(storyId)) return false;

    const res = await this.storyModel.updateOne(
      {
        _id: new Types.ObjectId(storyId),
        status: StoryStatus.Active,
        expiresAt: { $lte: new Date() },
      },
      { $set: { status: StoryStatus.Expired, expiredAt: new Date() } },
    );

    return res.modifiedCount > 0;
  }

  /** The sweep: everything whose time has passed, in one write. */
  async expireDue(): Promise<number> {
    const res = await this.storyModel.updateMany(
      { status: StoryStatus.Active, expiresAt: { $lte: new Date() } },
      { $set: { status: StoryStatus.Expired, expiredAt: new Date() } },
    );

    return res.modifiedCount ?? 0;
  }

  /* ---------- reading ---------- */

  /** The only definition of "live", used by every read path. */
  private activeFilter() {
    return { status: StoryStatus.Active, expiresAt: { $gt: new Date() } };
  }

  /**
   * Active stories from the people you follow, grouped by author and ordered
   * with the unseen ones first — the shape the story rail draws.
   *
   * Nobody else's stories are ever included: the author set is exactly your
   * following list.
   */
  async getFeed(viewerId: string) {
    const followingIds = await this.follows.getFollowingIds(viewerId);
    if (!followingIds.length) return { items: [] };

    const authors = followingIds.map((id) => new Types.ObjectId(id));

    const stories = await this.storyModel
      .find({ user: { $in: authors }, ...this.activeFilter() })
      .sort({ createdAt: 1 })
      .populate('user', AUTHOR_FIELDS)
      .lean();

    if (!stories.length) return { items: [] };

    const seen = await this.seenSet(
      viewerId,
      stories.map((s: any) => s._id),
    );

    // Group by author, keeping each author's stories in posting order.
    const byAuthor = new Map<string, any>();

    for (const story of stories as any[]) {
      const authorId = String(story.user?._id ?? story.user);

      if (!byAuthor.has(authorId)) {
        byAuthor.set(authorId, {
          user: this.author(story.user),
          stories: [],
          hasUnseen: false,
          lastPostedAt: story.createdAt,
        });
      }

      const group = byAuthor.get(authorId);
      const viewed = seen.has(String(story._id));

      group.stories.push(this.serialise(story, { viewed }));
      group.hasUnseen = group.hasUnseen || !viewed;
      group.lastPostedAt = story.createdAt;
    }

    const items = [...byAuthor.values()].sort((a, b) => {
      // Unseen authors first, then whoever posted most recently.
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      return new Date(b.lastPostedAt).getTime() - new Date(a.lastPostedAt).getTime();
    });

    return { items };
  }

  /** Your own live stories, for the "Your story" tile. */
  async getMine(userId: string) {
    const stories = await this.storyModel
      .find({ user: new Types.ObjectId(userId), ...this.activeFilter() })
      .sort({ createdAt: 1 })
      .lean();

    return {
      stories: stories.map((story) => this.serialise(story)),
      totalViews: stories.reduce((sum, s: any) => sum + (s.viewCount ?? 0), 0),
    };
  }

  /**
   * A single story, with its author — a deep link has no feed group to take
   * the name and avatar from. Readable by its owner, or by a follower while
   * it is live.
   */
  async findOne(storyId: string, viewerId: string) {
    const story = await this.loadVisible(storyId, viewerId);

    const [seen, liked] = await Promise.all([
      this.seenSet(viewerId, [story._id]),
      this.likedSet(viewerId, [story._id]),
    ]);

    return {
      ...this.serialise(story, {
        viewed: seen.has(String(story._id)),
        liked: liked.has(String(story._id)),
      }),
      user: this.author(story.user),
    };
  }

  /* ---------- views ---------- */

  /**
   * Record that someone watched a story.
   *
   * Idempotent: the unique (story, viewer) index means the count only moves
   * on the first view. An owner watching their own story is not a view.
   */
  async recordView(storyId: string, viewerId: string) {
    const story = await this.loadVisible(storyId, viewerId);

    if (String(story.user?._id ?? story.user) === String(viewerId)) {
      return { viewCount: story.viewCount ?? 0, counted: false };
    }

    try {
      await this.storyViewModel.create({
        story: story._id,
        viewer: new Types.ObjectId(viewerId),
        owner: story.user?._id ?? story.user,
      });
    } catch (error: any) {
      // Duplicate key: already counted, nothing to do.
      if (error?.code === 11000) {
        return { viewCount: story.viewCount ?? 0, counted: false };
      }
      throw error;
    }

    const updated = await this.storyModel
      .findByIdAndUpdate(story._id, { $inc: { viewCount: 1 } }, { new: true })
      .select('viewCount')
      .lean();

    return { viewCount: (updated as any)?.viewCount ?? 0, counted: true };
  }

  /* ---------- likes ---------- */

  /**
   * Heart a story, or take the heart back.
   *
   * A like always comes from someone who watched it, so it lives on the view
   * row: liking a story you have not opened records the view too. The owner
   * cannot like their own story, for the same reason their view is not
   * counted.
   */
  async toggleLike(storyId: string, viewerId: string) {
    const story = await this.loadVisible(storyId, viewerId);

    if (String(story.user?._id ?? story.user) === String(viewerId)) {
      throw new BadRequestException('You cannot like your own story');
    }

    const existing = await this.storyViewModel.findOne({
      story: story._id,
      viewer: new Types.ObjectId(viewerId),
    });

    // First contact with the story: it counts as a view as well as a like.
    if (!existing) {
      void this.notifyLike(story, viewerId);

      await this.storyViewModel.create({
        story: story._id,
        viewer: new Types.ObjectId(viewerId),
        owner: story.user?._id ?? story.user,
        liked: true,
        likedAt: new Date(),
      });

      const updated = await this.storyModel
        .findByIdAndUpdate(
          story._id,
          { $inc: { viewCount: 1, likeCount: 1 } },
          { new: true },
        )
        .select('viewCount likeCount')
        .lean();

      return {
        liked: true,
        likeCount: (updated as any)?.likeCount ?? 1,
        viewCount: (updated as any)?.viewCount ?? 1,
      };
    }

    const liked = !existing.liked;

    // Only the like is worth telling someone about; taking it back is not.
    if (liked) void this.notifyLike(story, viewerId);

    existing.liked = liked;
    existing.likedAt = liked ? new Date() : undefined;
    await existing.save();

    const updated = await this.storyModel
      .findByIdAndUpdate(
        story._id,
        // Never let a double unlike push the count below zero.
        liked
          ? { $inc: { likeCount: 1 } }
          : { $set: { likeCount: Math.max(0, (story.likeCount ?? 1) - 1) } },
        { new: true },
      )
      .select('viewCount likeCount')
      .lean();

    return {
      liked,
      likeCount: (updated as any)?.likeCount ?? 0,
      viewCount: (updated as any)?.viewCount ?? 0,
    };
  }

  /**
   * Tell the owner someone hearted their story. Best effort: notify()
   * swallows its own errors, and it drops a notification whose actor is the
   * recipient, so this can never ping you about yourself.
   */
  private async notifyLike(story: any, actorId: string) {
    const ownerId = String(story.user?._id ?? story.user);

    const actor = await this.userModel
      .findById(actorId)
      .select('firstName lastName username')
      .lean();

    const actorName = displayName(actor);

    void this.notifications.notify({
      users: ownerId,
      actor: actorId,
      type: NotificationType.StoryLike,
      title: actorName,
      body: `${actorName} liked your story`,
      metadata: { storyId: String(story._id), userId: actorId },
    });
  }

  /** Who viewed a story. Owner only — this is their insights screen. */
  async getViewers(storyId: string, ownerId: string, page = 1, limit = 20) {
    const story = await this.storyModel.findById(this.objectId(storyId)).lean();
    if (!story) throw new NotFoundException('Story not found');

    if (String((story as any).user) !== String(ownerId)) {
      throw new ForbiddenException('Only the owner can see who viewed a story');
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const [rows, total] = await Promise.all([
      this.storyViewModel
        .find({ story: (story as any)._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .populate('viewer', AUTHOR_FIELDS)
        .lean(),
      this.storyViewModel.countDocuments({ story: (story as any)._id }),
    ]);

    return {
      items: rows.map((row: any) => ({
        ...this.author(row.viewer),
        viewedAt: row.createdAt,
        liked: !!row.liked,
      })),
      page: safePage,
      limit: safeLimit,
      total,
      hasMore: safePage * safeLimit < total,
    };
  }

  /* ---------- replies ---------- */

  /**
   * Reply to a story as a chat message.
   *
   * Goes through the ordinary chat flow — the same conversation, the same
   * message collection, the same socket events — with the story attached to
   * the message as a snapshot. Because the snapshot carries the media keys,
   * the thread still shows what was replied to once the story has expired,
   * and the story row itself is never deleted, so `storyId` keeps resolving.
   */
  async reply(storyId: string, senderId: string, text: string) {
    const body = text?.trim();
    if (!body) throw new BadRequestException('A reply needs some text');

    const story = await this.loadVisible(storyId, senderId);
    const ownerId = String(story.user?._id ?? story.user);

    if (ownerId === String(senderId)) {
      throw new BadRequestException('You cannot reply to your own story');
    }

    const sent = await this.sendStoryMessage(story, senderId, ownerId, body);

    this.logger.log(
      `story ${storyId} replied to by ${senderId} in conversation ${sent.conversationId}`,
    );

    return sent;
  }

  /**
   * Send a story into one or more chats.
   *
   * The same plumbing as a reply — an ordinary chat message carrying the
   * story — just addressed to whoever was picked instead of the owner. Your
   * own story can be shared this way; a story you cannot open cannot.
   */
  async share(storyId: string, senderId: string, dto: ShareStoryDto) {
    const story = await this.loadVisible(storyId, senderId);
    const ownerId = String(story.user?._id ?? story.user);
    const text = dto.text?.trim() || '';

    // One entry per recipient, deduped, never yourself.
    const recipients = [...new Set(dto.userIds.map(String))].filter(
      (id) => id !== String(senderId),
    );

    if (!recipients.length) {
      throw new BadRequestException('Pick at least one person to share with');
    }

    const results = await Promise.all(
      recipients.map(async (recipientId) => {
        try {
          const sent = await this.sendStoryMessage(
            story,
            senderId,
            recipientId,
            text,
            'Shared a story',
          );
          return { userId: recipientId, ...sent, sent: true };
        } catch (error) {
          // One blocked or deleted recipient must not fail the whole share.
          this.logger.warn(
            `story ${storyId} share to ${recipientId} failed: ${(error as Error).message}`,
          );
          return {
            userId: recipientId,
            sent: false,
            reason: (error as Error).message,
          };
        }
      }),
    );

    this.logger.log(
      `story ${storyId} shared by ${senderId} to ${results.filter((r) => r.sent).length}/${recipients.length} chats`,
    );

    return { owner: ownerId, results };
  }

  /**
   * One chat message carrying a story: existing conversation if there is one,
   * a new one if not, then the same socket events a typed message produces.
   *
   * The story is attached as a snapshot (see MessageStoryRef), which is what
   * lets the thread still show it once the story has expired.
   */
  private async sendStoryMessage(
    story: any,
    senderId: string,
    recipientId: string,
    text: string,
    previewText?: string,
  ) {
    const conversation = await this.chat.getOrCreateConversation(senderId, recipientId);
    const conversationId = String((conversation as any)._id);

    const message = await this.chat.createMessage(
      senderId,
      recipientId,
      conversationId,
      text,
      undefined,
      {
        previewText,
        story: {
          storyId: String(story._id),
          owner: String(story.user?._id ?? story.user),
          mediaType: story.mediaType,
          mediaKey: story.mediaKey,
          thumbnailKey: story.thumbnailKey,
          postedAt: story.createdAt,
        },
      },
    );

    this.chatGateway.broadcastMessage(conversationId, message, [senderId, recipientId]);

    return { conversationId, message };
  }

  /* ---------- deletion ---------- */

  /** Taking a story down keeps the row; it just stops being live. */
  async remove(storyId: string, userId: string) {
    const story = await this.storyModel.findById(this.objectId(storyId));
    if (!story) throw new NotFoundException('Story not found');

    if (String(story.user) !== String(userId)) {
      throw new ForbiddenException('You can only delete your own story');
    }

    if (story.status === StoryStatus.Active) {
      story.status = StoryStatus.Deleted;
      await story.save();
    }

    return { message: 'Story deleted' };
  }

  /* ---------- internals ---------- */

  /**
   * A story the viewer is allowed to open: their own, or a live one from
   * someone they follow.
   */
  private async loadVisible(storyId: string, viewerId: string) {
    const story: any = await this.storyModel
      .findById(this.objectId(storyId))
      .populate('user', AUTHOR_FIELDS)
      .lean();

    if (!story) throw new NotFoundException('Story not found');

    const ownerId = String(story.user?._id ?? story.user);
    if (ownerId === String(viewerId)) return story;

    const live =
      story.status === StoryStatus.Active &&
      new Date(story.expiresAt).getTime() > Date.now();

    if (!live) throw new NotFoundException('Story is no longer available');

    const follows = await this.follows.isFollowing(viewerId, ownerId);
    if (!follows) {
      throw new ForbiddenException('You can only view stories from people you follow');
    }

    return story;
  }

  /** Which of these stories the viewer has already seen. */
  private async seenSet(viewerId: string, storyIds: any[]): Promise<Set<string>> {
    if (!storyIds.length) return new Set();

    const rows = await this.storyViewModel
      .find({ viewer: new Types.ObjectId(viewerId), story: { $in: storyIds } })
      .select('story')
      .lean();

    return new Set(rows.map((row: any) => String(row.story)));
  }

  /** Which of these stories the viewer has hearted. */
  private async likedSet(viewerId: string, storyIds: any[]): Promise<Set<string>> {
    if (!storyIds.length) return new Set();

    const rows = await this.storyViewModel
      .find({
        viewer: new Types.ObjectId(viewerId),
        story: { $in: storyIds },
        liked: true,
      })
      .select('story')
      .lean();

    return new Set(rows.map((row: any) => String(row.story)));
  }

  /** A client-supplied key is only trustworthy once proven to be the caller's. */
  private async assertOwnedObject(userId: string, key: string, prefixes: string[]) {
    const owned = prefixes.some((prefix) => key.startsWith(`${prefix}/${userId}/`));

    if (!owned) {
      this.logger.warn(`story upload rejected: user=${userId} does not own key=${key}`);
      throw new ForbiddenException('Invalid media key for this user');
    }

    const head = await this.uploadService.headObject(key);
    if (!head) {
      throw new BadRequestException('Uploaded object was not found');
    }
  }

  private author(user: any) {
    if (!user) return null;

    return {
      id: String(user._id ?? user),
      name: displayName(user, 'Anonymous'),
      username: user.username ?? null,
      avatar: this.mediaUrl.toUrl(user.profileImage),
    };
  }

  private serialise(story: any, extra: { viewed?: boolean; liked?: boolean } = {}) {
    const plain = typeof story.toObject === 'function' ? story.toObject() : story;

    return {
      id: String(plain._id),
      mediaType: plain.mediaType,
      url: this.mediaUrl.toUrl(plain.mediaKey),
      poster: this.mediaUrl.toUrl(plain.thumbnailKey),
      durationSeconds: plain.durationSeconds ?? null,
      music: plain.music ?? null,
      viewCount: plain.viewCount ?? 0,
      likeCount: plain.likeCount ?? 0,
      createdAt: plain.createdAt,
      expiresAt: plain.expiresAt,
      ...extra,
    };
  }

  private objectId(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid story id');
    }
    return new Types.ObjectId(id);
  }
}
