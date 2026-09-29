import { Types } from 'mongoose';
import { StoriesService } from './stories.service';
import { StoryMediaType, StoryStatus } from '../../database/schemas/story/story.schema';

/**
 * The rules that matter: a story only stays live for 24 hours, a feed only
 * carries people you follow, and a viewer counts once.
 */
function setup(opts: {
  stories?: any[];
  story?: any;
  following?: string[];
  isFollowing?: boolean;
  views?: any[];
  duplicateView?: boolean;
  existingView?: any;
} = {}) {
  const chain = (value: any) => {
    const q: any = {
      select: () => q,
      sort: () => q,
      skip: () => q,
      limit: () => q,
      populate: () => q,
      lean: () => Promise.resolve(value),
    };
    return q;
  };

  const storyModel: any = {
    create: jest.fn((doc) => Promise.resolve({ ...doc, _id: new Types.ObjectId() })),
    find: jest.fn(() => chain(opts.stories ?? [])),
    findById: jest.fn(() => chain(opts.story ?? null)),
    findByIdAndUpdate: jest.fn(() => chain({ viewCount: 1, likeCount: 1 })),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 })),
    updateMany: jest.fn(() => Promise.resolve({ modifiedCount: 3 })),
    countDocuments: jest.fn(() => Promise.resolve(0)),
  };

  const existingView = opts.existingView;

  const storyViewModel: any = {
    create: jest.fn(() =>
      opts.duplicateView ? Promise.reject({ code: 11000 }) : Promise.resolve({}),
    ),
    findOne: jest.fn(() => Promise.resolve(existingView ?? null)),
    find: jest.fn(() => chain(opts.views ?? [])),
    countDocuments: jest.fn(() => Promise.resolve((opts.views ?? []).length)),
  };

  const queue = { add: jest.fn((..._args: any[]) => Promise.resolve()) };

  const follows = {
    getFollowingIds: jest.fn(() => Promise.resolve(opts.following ?? [])),
    isFollowing: jest.fn(() => Promise.resolve(opts.isFollowing ?? true)),
  };

  const uploadService = { headObject: jest.fn(() => Promise.resolve({ size: 1000 })) };

  const chat = {
    getOrCreateConversation: jest.fn((..._args: any[]) => Promise.resolve({ _id: id() } as any)),
    createMessage: jest.fn((..._args: any[]) => Promise.resolve({ _id: id() })),
  };
  const chatGateway = { broadcastMessage: jest.fn() };
  const mediaUrl = { toUrl: (v: any) => (v ? `https://cdn.test/${v}` : null) };

  const service = new StoriesService(
    storyModel,
    storyViewModel,
    queue as any,
    follows as any,
    chat as any,
    chatGateway as any,
    uploadService as any,
    mediaUrl as any,
  );

  return { service, storyModel, storyViewModel, queue, follows, chat, chatGateway };
}

const id = () => new Types.ObjectId();
const user = (uid: string) => ({ _id: uid, username: 'someone' });

const liveStory = (ownerId: string, extra: any = {}) => ({
  _id: id(),
  user: user(ownerId),
  mediaType: StoryMediaType.Image,
  mediaKey: 'thumbnails/x/1.jpg',
  status: StoryStatus.Active,
  expiresAt: new Date(Date.now() + 60_000),
  viewCount: 4,
  createdAt: new Date(),
  ...extra,
});

describe('StoriesService', () => {
  describe('create', () => {
    it('schedules expiry 24 hours out', async () => {
      const uid = String(id());
      const t = setup();

      await t.service.create(uid, {
        mediaType: StoryMediaType.Image,
        mediaKey: `thumbnails/${uid}/photo.jpg`,
      } as any);

      const options = (t.queue.add.mock.calls[0] as any[])[2];
      // Within a second of 24h, allowing for the clock between the two reads.
      expect(options.delay).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
      expect(options.delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

      const created = t.storyModel.create.mock.calls[0][0];
      expect(created.status).toBe(StoryStatus.Active);
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses a key belonging to someone else', async () => {
      const t = setup();

      await expect(
        t.service.create(String(id()), {
          mediaType: StoryMediaType.Image,
          mediaKey: `thumbnails/${String(id())}/photo.jpg`,
        } as any),
      ).rejects.toThrow(/Invalid media key/);
    });

    it('refuses a clip over 30 seconds', async () => {
      const uid = String(id());
      const t = setup();

      await expect(
        t.service.create(uid, {
          mediaType: StoryMediaType.Video,
          mediaKey: `videos/${uid}/clip.mp4`,
          durationSeconds: 45,
        } as any),
      ).rejects.toThrow(/30 seconds/);
    });

    it('refuses a video with no duration', async () => {
      const uid = String(id());
      const t = setup();

      await expect(
        t.service.create(uid, {
          mediaType: StoryMediaType.Video,
          mediaKey: `videos/${uid}/clip.mp4`,
        } as any),
      ).rejects.toThrow(/duration/);
    });
  });

  describe('expiry', () => {
    it('only expires a story that is active and past its time', async () => {
      const t = setup();
      await t.service.expire(String(id()));

      const filter = t.storyModel.updateOne.mock.calls[0][0];
      expect(filter.status).toBe(StoryStatus.Active);
      expect(filter.expiresAt.$lte).toBeInstanceOf(Date);
    });

    it('does nothing for an id that cannot be a story', async () => {
      const t = setup();
      expect(await t.service.expire('not-an-id')).toBe(false);
      expect(t.storyModel.updateOne).not.toHaveBeenCalled();
    });

    it('never deletes — the sweep only sets a status', async () => {
      const t = setup();
      await t.service.expireDue();

      const update = t.storyModel.updateMany.mock.calls[0][1];
      expect(update.$set.status).toBe(StoryStatus.Expired);
      expect(t.storyModel.updateMany.mock.calls[0][1].$unset).toBeUndefined();
    });
  });

  describe('feed', () => {
    it('is empty when you follow nobody', async () => {
      const t = setup({ following: [] });

      expect(await t.service.getFeed(String(id()))).toEqual({ items: [] });
      expect(t.storyModel.find).not.toHaveBeenCalled();
    });

    it('asks only for followed authors, and only for live stories', async () => {
      const author = String(id());
      const t = setup({ following: [author], stories: [] });

      await t.service.getFeed(String(id()));

      const filter = t.storyModel.find.mock.calls[0][0];
      expect(filter.user.$in.map(String)).toEqual([author]);
      expect(filter.status).toBe(StoryStatus.Active);
      expect(filter.expiresAt.$gt).toBeInstanceOf(Date);
    });

    it('groups by author and puts unseen first', async () => {
      const seenAuthor = String(id());
      const freshAuthor = String(id());
      const seenStory = liveStory(seenAuthor);
      const freshStory = liveStory(freshAuthor);

      const t = setup({
        following: [seenAuthor, freshAuthor],
        stories: [seenStory, freshStory],
        views: [{ story: seenStory._id }],
      });

      const { items } = await t.service.getFeed(String(id()));

      expect(items).toHaveLength(2);
      expect(items[0].hasUnseen).toBe(true);
      expect(items[0].user.id).toBe(freshAuthor);
      expect(items[1].stories[0].viewed).toBe(true);
    });
  });

  describe('views', () => {
    it('counts a follower’s first view', async () => {
      const owner = String(id());
      const t = setup({ story: liveStory(owner), isFollowing: true });

      const res = await t.service.recordView(String(id()), String(id()));

      expect(res).toEqual({ viewCount: 1, counted: true });
      expect(t.storyModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('does not count the same viewer twice', async () => {
      const owner = String(id());
      const t = setup({ story: liveStory(owner), isFollowing: true, duplicateView: true });

      const res = await t.service.recordView(String(id()), String(id()));

      expect(res).toEqual({ viewCount: 4, counted: false });
      expect(t.storyModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('does not count the owner watching their own story', async () => {
      const owner = String(id());
      const t = setup({ story: liveStory(owner) });

      const res = await t.service.recordView(String(id()), owner);

      expect(res).toEqual({ viewCount: 4, counted: false });
      expect(t.storyViewModel.create).not.toHaveBeenCalled();
    });

    it('refuses a story from someone you do not follow', async () => {
      const t = setup({ story: liveStory(String(id())), isFollowing: false });

      await expect(
        t.service.recordView(String(id()), String(id())),
      ).rejects.toThrow(/people you follow/);
    });

    it('refuses an expired story', async () => {
      const expired = liveStory(String(id()), {
        status: StoryStatus.Expired,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const t = setup({ story: expired, isFollowing: true });

      await expect(
        t.service.recordView(String(id()), String(id())),
      ).rejects.toThrow(/no longer available/);
    });
  });

  describe('reply', () => {
    it('sends through the existing chat flow with the story attached', async () => {
      const owner = String(id());
      const sender = String(id());
      const story = liveStory(owner, { mediaKey: 'thumbnails/o/1.jpg' });
      const t = setup({ story, isFollowing: true });

      const res = await t.service.reply(String(story._id), sender, '  nice one  ');

      // Reuses a conversation if there is one, creates it if not.
      expect(t.chat.getOrCreateConversation).toHaveBeenCalledWith(sender, owner);

      const [senderArg, recipientArg, , text, image, options] =
        t.chat.createMessage.mock.calls[0] as any[];
      expect(senderArg).toBe(sender);
      expect(recipientArg).toBe(owner);
      expect(text).toBe('nice one');
      expect(image).toBeUndefined();

      // The snapshot is what survives the story expiring.
      expect(options.story).toMatchObject({
        storyId: String(story._id),
        owner,
        mediaType: story.mediaType,
        mediaKey: 'thumbnails/o/1.jpg',
        postedAt: story.createdAt,
      });

      // Same socket events as a message typed in the thread.
      expect(t.chatGateway.broadcastMessage).toHaveBeenCalledWith(
        res.conversationId,
        expect.anything(),
        [sender, owner],
      );
    });

    it('refuses an empty reply', async () => {
      const t = setup({ story: liveStory(String(id())), isFollowing: true });

      await expect(t.service.reply(String(id()), String(id()), '   ')).rejects.toThrow(
        /needs some text/,
      );
      expect(t.chat.createMessage).not.toHaveBeenCalled();
    });

    it('refuses a reply to your own story', async () => {
      const owner = String(id());
      const t = setup({ story: liveStory(owner) });

      await expect(t.service.reply(String(id()), owner, 'hi')).rejects.toThrow(
        /your own story/,
      );
    });

    it('refuses a reply to an expired story', async () => {
      const expired = liveStory(String(id()), {
        status: StoryStatus.Expired,
        expiresAt: new Date(Date.now() - 1000),
      });
      const t = setup({ story: expired, isFollowing: true });

      await expect(t.service.reply(String(id()), String(id()), 'hi')).rejects.toThrow(
        /no longer available/,
      );
    });
  });

  describe('likes', () => {
    it('counts a first like as a view too', async () => {
      const t = setup({ story: liveStory(String(id())), isFollowing: true });

      const res = await t.service.toggleLike(String(id()), String(id()));

      expect(res).toMatchObject({ liked: true, likeCount: 1 });
      // No view row yet, so the like records one.
      expect(t.storyViewModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ liked: true }),
      );
      const update = t.storyModel.findByIdAndUpdate.mock.calls[0][1];
      expect(update.$inc).toEqual({ viewCount: 1, likeCount: 1 });
    });

    it('unlikes without touching the view count', async () => {
      const existingView: any = { liked: true, save: jest.fn() };
      const t = setup({
        story: liveStory(String(id()), { likeCount: 3 }),
        isFollowing: true,
        existingView,
      });

      const res = await t.service.toggleLike(String(id()), String(id()));

      expect(res.liked).toBe(false);
      expect(existingView.liked).toBe(false);
      expect(existingView.save).toHaveBeenCalled();
      const update = t.storyModel.findByIdAndUpdate.mock.calls[0][1];
      expect(update.$set).toEqual({ likeCount: 2 });
    });

    it('never lets the count go below zero', async () => {
      const existingView: any = { liked: true, save: jest.fn() };
      const t = setup({
        story: liveStory(String(id()), { likeCount: 0 }),
        isFollowing: true,
        existingView,
      });

      await t.service.toggleLike(String(id()), String(id()));

      expect(t.storyModel.findByIdAndUpdate.mock.calls[0][1].$set).toEqual({ likeCount: 0 });
    });

    it('refuses a like on your own story', async () => {
      const owner = String(id());
      const t = setup({ story: liveStory(owner) });

      await expect(t.service.toggleLike(String(id()), owner)).rejects.toThrow(/your own story/);
    });
  });

  describe('share', () => {
    it('sends the story to every chosen chat', async () => {
      const t = setup({ story: liveStory(String(id())), isFollowing: true });
      const a = String(id());
      const b = String(id());

      const res = await t.service.share(String(id()), String(id()), {
        userIds: [a, b],
        text: 'look at this',
      });

      expect(t.chat.createMessage).toHaveBeenCalledTimes(2);
      expect(res.results.every((r: any) => r.sent)).toBe(true);
      expect(t.chatGateway.broadcastMessage).toHaveBeenCalledTimes(2);

      const options = (t.chat.createMessage.mock.calls[0] as any[])[5];
      expect(options.story.storyId).toBeDefined();
    });

    it('drops duplicates and yourself', async () => {
      const me = String(id());
      const friend = String(id());
      const t = setup({ story: liveStory(String(id())), isFollowing: true });

      const res = await t.service.share(String(id()), me, {
        userIds: [friend, friend, me],
      } as any);

      expect(res.results).toHaveLength(1);
      expect(res.results[0].userId).toBe(friend);
    });

    it('refuses a share with nobody left to send to', async () => {
      const me = String(id());
      const t = setup({ story: liveStory(String(id())), isFollowing: true });

      await expect(
        t.service.share(String(id()), me, { userIds: [me] } as any),
      ).rejects.toThrow(/at least one person/);
    });

    it('keeps going when one recipient fails', async () => {
      const t = setup({ story: liveStory(String(id())), isFollowing: true });
      t.chat.getOrCreateConversation
        .mockRejectedValueOnce(new Error('You cannot start a conversation with this user.'))
        .mockResolvedValueOnce({ _id: id() } as any);

      const res = await t.service.share(String(id()), String(id()), {
        userIds: [String(id()), String(id())],
      } as any);

      expect(res.results.filter((r: any) => r.sent)).toHaveLength(1);
      expect(res.results.find((r: any) => !r.sent)?.reason).toMatch(/cannot start/);
    });
  });

  describe('viewers', () => {
    it('is owner-only', async () => {
      const t = setup({ story: { _id: id(), user: id() } });

      await expect(
        t.service.getViewers(String(id()), String(id())),
      ).rejects.toThrow(/Only the owner/);
    });
  });
});
