import { Types } from 'mongoose';
import { FeedService } from './feed.service';
import { CampaignStatus } from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { ModerationStatus } from '../../database/schemas/video/video.schema';

function setup(rows: any[] = [], blockedUsers: Types.ObjectId[] = []) {
  const query: any = {};
  for (const method of [
    'select',
    'sort',
    'limit',
    'populate',
    'lean',
    'skip',
  ]) {
    query[method] = jest.fn(() => query);
  }
  query.exec = jest.fn().mockResolvedValue([...rows]);
  const videos = { find: jest.fn((_filter: any) => query) };
  const users = {
    findById: jest.fn(() => ({
      select: () => ({ lean: async () => ({ blockedUsers }) }),
    })),
  };
  const campaigns = {
    distinct: jest.fn(async (_field: string, _filter: any) =>
      rows.map((v) => v._id),
    ),
  };
  const likes = { hasUserLikedVideos: jest.fn().mockResolvedValue(new Map()) };
  const delivery = { pickForViewer: jest.fn() };
  const service = new FeedService(
    videos as any,
    {} as any,
    users as any,
    likes as any,
    { toPublicUser: (u: any) => u, toUrl: (key: string) => key } as any,
    delivery as any,
    campaigns as any,
  );
  return { service, videos, users, campaigns, likes, delivery, query };
}
const video = () => ({
  _id: new Types.ObjectId(),
  createdAt: new Date(),
  isBoosted: true,
  user: { _id: new Types.ObjectId() },
  rawVideoKey: 'video.mp4',
});

describe('Boosted feed', () => {
  it('requires live, started, unexpired campaigns with views left', async () => {
    const h = setup();
    await h.service.getBoostedFeed({});
    expect(h.campaigns.distinct).toHaveBeenCalledWith('video', {
      status: CampaignStatus.ACTIVE,
      startAt: { $lte: expect.any(Date) },
      endAt: { $gt: expect.any(Date) },
      $expr: { $lt: ['$deliveredViews', '$targetViews'] },
    });
    expect(h.videos.find).toHaveBeenCalledWith({
      _id: { $in: [] },
      isBoosted: true,
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    });
    expect(h.delivery.pickForViewer).not.toHaveBeenCalled();
  });
  it('filters blocked authors and preserves viewer likes and playable URLs', async () => {
    const row = video();
    const blocked = new Types.ObjectId();
    const h = setup([row], [blocked]);
    h.likes.hasUserLikedVideos.mockResolvedValue(
      new Map([[String(row._id), true]]),
    );
    const result = await h.service.getBoostedFeed(
      {},
      new Types.ObjectId().toString(),
    );
    expect(h.videos.find.mock.calls[0][0]).toMatchObject({
      _id: { $in: [row._id] },
      user: { $nin: [blocked] },
    });
    expect(result.docs[0]).toMatchObject({
      isBoosted: true,
      hasLiked: true,
      videoUrl: 'video.mp4',
    });
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
  it('paginates within the boosted filter using timestamp and ID', async () => {
    const rows = [video(), video()];
    const h = setup(rows);
    const first = await h.service.getBoostedFeed({ limit: 1 });
    expect(first.docs).toHaveLength(1);
    expect(first.hasNextPage).toBe(true);
    await h.service.getBoostedFeed({ limit: 1, cursor: first.nextCursor! });
    expect(h.videos.find.mock.calls[1][0]).toMatchObject({
      isBoosted: true,
      $and: [
        {
          $or: [
            { createdAt: { $lt: rows[0].createdAt } },
            { createdAt: rows[0].createdAt, _id: { $lt: rows[0]._id } },
          ],
        },
      ],
    });
    expect(h.query.skip).toHaveBeenCalledTimes(1);
    expect(h.query.limit).toHaveBeenCalledWith(2);
  });
  it('supports guests and offset pages without filling an empty feed with organic videos', async () => {
    const h = setup();
    const result = await h.service.getBoostedFeed({ page: 2, limit: 5 });
    expect(result.docs).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(h.query.skip).toHaveBeenCalledWith(5);
    expect(h.users.findById).not.toHaveBeenCalled();
    expect(h.likes.hasUserLikedVideos).not.toHaveBeenCalled();
  });
});

describe('Existing feeds', () => {
  it('keeps All unfiltered and injects paid slots for signed-in viewers', async () => {
    const h = setup([video()]);
    h.delivery.pickForViewer.mockResolvedValue([] as never);
    await h.service.getGlobalFeed({}, new Types.ObjectId().toString());
    expect(h.videos.find.mock.calls[0][0]).toEqual({
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    });
    expect(h.campaigns.distinct).not.toHaveBeenCalled();
    expect(h.delivery.pickForViewer).toHaveBeenCalled();
  });
});
