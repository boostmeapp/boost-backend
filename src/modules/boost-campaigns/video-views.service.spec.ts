import { Types } from 'mongoose';
import { VideoViewsService } from './video-views.service';
import {
  CampaignEndReason,
  CampaignStatus,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';

const lean = (v: any) => ({
  select: () => ({ lean: () => Promise.resolve(v) }),
});

function setup(
  opts: {
    campaign?: any; // null → the video has no live boost
    matches?: boolean;
    blocked?: boolean;
    duplicateView?: boolean;
    firstView?: boolean;
    increment?: any;
    newImpression?: boolean;
  } = {},
) {
  const owner = new Types.ObjectId();
  const video = { _id: new Types.ObjectId(), user: owner, duration: 30 };
  const campaign =
    opts.campaign === undefined
      ? {
          _id: new Types.ObjectId(),
          video: video._id,
          user: owner,
          targeting: {},
          status: CampaignStatus.ACTIVE,
          endAt: new Date(Date.now() + 3600_000),
          targetViews: 10,
          deliveredViews: 3,
        }
      : opts.campaign;

  const videoModel = {
    findById: jest.fn(() => lean(video)),
    updateOne: jest.fn(() => Promise.resolve({})),
  };
  const userModel = {
    findById: jest.fn(() => lean({ _id: 'viewer' })),
    exists: jest.fn(() => Promise.resolve(opts.blocked ? { _id: 1 } : null)),
  };
  const campaignModel = {
    findOne: jest.fn(() => lean(campaign)),
    findOneAndUpdate: jest.fn(() =>
      Promise.resolve(
        opts.increment === undefined
          ? { ...campaign, deliveredViews: 4 }
          : opts.increment,
      ),
    ),
    updateOne: jest.fn(() => Promise.resolve({})),
  };
  const impressionModel = {
    updateOne: jest.fn(() =>
      Promise.resolve({ upsertedCount: opts.newImpression ? 1 : 0 }),
    ),
  };
  const viewModel = {
    create: jest.fn(() =>
      opts.duplicateView
        ? Promise.reject({ code: 11000 })
        : Promise.resolve({}),
    ),
  };
  const campaigns = { settle: jest.fn(() => Promise.resolve(null)) };
  const targeting = { matchesViewer: jest.fn(() => opts.matches !== false) };
  const redis = {
    incrWithTtl: jest.fn(() => Promise.resolve(1)),
    setIfAbsent: jest.fn(() => Promise.resolve(opts.firstView ?? true)),
  };

  const service = new VideoViewsService(
    videoModel as any,
    userModel as any,
    campaignModel as any,
    impressionModel as any,
    viewModel as any,
    campaigns as any,
    targeting as any,
    redis as any,
  );

  return {
    service,
    video,
    campaign,
    owner,
    videoModel,
    campaignModel,
    impressionModel,
    viewModel,
    campaigns,
  };
}

const viewerId = () => String(new Types.ObjectId());

describe('VideoViewsService.report', () => {
  it('counts a qualified view once and credits the live boost', async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 5 },
      viewerId(),
    );

    expect(t.videoModel.updateOne).toHaveBeenCalledWith(
      { _id: t.video._id },
      { $inc: { viewCount: 1, watchTimeTotal: 5 } },
    );
    expect(t.viewModel.create).toHaveBeenCalled();
    expect(t.campaignModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('credits the boost without a campaignId, from any screen', async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.campaignModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        video: t.video._id,
        status: CampaignStatus.ACTIVE,
      }),
    );
    expect(t.viewModel.create).toHaveBeenCalled();
  });

  it('adds a viewer reached outside a boost slot to the reach numbers', async () => {
    const t = setup({ newImpression: true });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.campaignModel.updateOne).toHaveBeenCalledWith(
      { _id: t.campaign._id },
      { $inc: { uniqueReach: 1 } },
    );
  });

  it('ignores views shorter than the threshold', async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 2 },
      viewerId(),
    );
    expect(t.videoModel.updateOne).not.toHaveBeenCalled();
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it("doesn't count the owner's own views", async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      String(t.owner),
    );
    expect(t.videoModel.updateOne).not.toHaveBeenCalled();
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it('skips viewCount within the 24h dedupe window', async () => {
    const t = setup({ firstView: false });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.videoModel.updateOne).not.toHaveBeenCalled();
  });

  it('counts guest views (by device) but never credits a boost', async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      undefined,
      'device-1',
    );
    expect(t.videoModel.updateOne).toHaveBeenCalled();
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it('does nothing for the boost when the video has none live', async () => {
    const t = setup({ campaign: null });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.videoModel.updateOne).toHaveBeenCalled(); // still a view
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it("doesn't credit a viewer outside the boost's audience", async () => {
    const t = setup({ matches: false });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it("doesn't credit across a block", async () => {
    const t = setup({ blocked: true });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it('counts a viewer once per boost', async () => {
    const t = setup({ duplicateView: true });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.campaignModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects impossible watch times for the boost', async () => {
    const t = setup();
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 999 },
      viewerId(),
    );
    expect(t.viewModel.create).not.toHaveBeenCalled();
  });

  it('completes the boost on the view that reaches the target', async () => {
    const t = setup({
      increment: { _id: 'c1', deliveredViews: 10, targetViews: 10 },
    });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.campaigns.settle).toHaveBeenCalledWith(
      'c1',
      CampaignStatus.COMPLETED,
      CampaignEndReason.TARGET_REACHED,
    );
  });

  it('does not overshoot when the guarded increment finds the target already met', async () => {
    const t = setup({ increment: null });
    await t.service.report(
      String(t.video._id),
      { watchSeconds: 10 },
      viewerId(),
    );
    expect(t.campaigns.settle).not.toHaveBeenCalled();
  });
});
