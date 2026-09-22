jest.mock('../../config', () => ({ ENV: { BOOST_VIEWS_PER_COIN: 4 } }));

import { Types } from 'mongoose';
import { BoostCampaignsService } from './boost-campaigns.service';
import {
  AudienceSize,
  CampaignEndReason,
  CampaignStatus,
  TargetAge,
  TargetGender,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';

const targeting = {
  audienceSize: AudienceSize.BALANCED,
  age: TargetAge.ABOVE_18,
  gender: TargetGender.ALL,
};

function setup(
  opts: { eligible?: number; campaign?: any; settleWins?: boolean } = {},
) {
  const campaign = opts.campaign;

  const campaignModel = {
    findById: jest.fn(() => ({ lean: () => Promise.resolve(campaign) })),
    findOneAndUpdate: jest.fn((_filter, update) =>
      Promise.resolve(
        opts.settleWins === false ? null : { ...campaign, ...update },
      ),
    ),
  };
  const videoModel = { updateOne: jest.fn(() => Promise.resolve({})) };
  const targetingService = {
    countEligible: jest.fn(() => Promise.resolve(opts.eligible ?? 0)),
  };
  const coins = {
    refundCoins: jest.fn(() => Promise.resolve({ coinBalance: 0 })),
    spendCoins: jest.fn(),
    getBalance: jest.fn(() => Promise.resolve({ coinBalance: 0 })),
  };
  const notifications = { notify: jest.fn(() => Promise.resolve([])) };
  const redis = { delValue: jest.fn(() => Promise.resolve(1)) };

  const service = new BoostCampaignsService(
    campaignModel as any,
    videoModel as any,
    targetingService as any,
    coins as any,
    notifications as any,
    redis as any,
    { toUrl: (v: string) => v } as any,
  );

  return { service, campaignModel, videoModel, coins, notifications };
}

describe('BoostCampaignsService.estimate', () => {
  it('is limited by purchased views when the audience is big enough', async () => {
    const { service } = setup({ eligible: 10_000 });
    const q = await service.estimate('owner', {
      targeting, // balanced → 5,000 people
      coins: 500,
      durationDays: 3,
    });

    expect(q.audienceReach).toBe(5000);
    expect(q.requestedViews).toBe(2000);
    expect(q.finalReach).toBe(2000);
    expect(q.coinsCharged).toBe(500);
  });

  it('is limited by the audience share and charges only what that needs', async () => {
    const { service } = setup({ eligible: 47 });
    const q = await service.estimate('owner', {
      targeting: { ...targeting, audienceSize: AudienceSize.WIDE },
      coins: 500,
      durationDays: 3,
    });

    expect(q.audienceReach).toBe(47);
    expect(q.requestedViews).toBe(2000);
    expect(q.finalReach).toBe(47);
    expect(q.targetViews).toBe(47); // the campaign's delivery target
    expect(q.coinsCharged).toBe(12); // ceil(47 / 4)
    expect(q.coinsRequested).toBe(500);
    expect(q.maxUsefulCoins).toBe(12);
  });

  it('gives each audience size a different reach', async () => {
    const { service } = setup({ eligible: 47 });
    const reachFor = async (audienceSize: AudienceSize) =>
      (
        await service.estimate('owner', {
          targeting: { ...targeting, audienceSize },
          coins: 500,
          durationDays: 3,
        })
      ).finalReach;

    expect(await reachFor(AudienceSize.SPECIFIC)).toBe(9);
    expect(await reachFor(AudienceSize.BALANCED)).toBe(23);
    expect(await reachFor(AudienceSize.WIDE)).toBe(47);
  });

  it('persists only the known targeting fields', async () => {
    const { service } = setup({ eligible: 10 });
    const q = await service.estimate('owner', {
      targeting: { ...targeting, extra: 'ignored' } as any,
      coins: 100,
      durationDays: 1,
    });
    expect(q.targeting).toEqual(targeting);
  });
});

describe('BoostCampaignsService.settle', () => {
  const base = () => ({
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(),
    video: new Types.ObjectId(),
    status: CampaignStatus.ACTIVE,
    coinsCharged: 500,
    viewsPerCoin: 4,
    targetViews: 2000,
    deliveredViews: 0,
  });

  it('refunds the undelivered share when time runs out', async () => {
    const campaign = { ...base(), deliveredViews: 1001 };
    const { service, coins } = setup({ campaign });

    const settled = await service.settle(
      campaign._id,
      CampaignStatus.EXPIRED,
      CampaignEndReason.TIME_UP,
    );

    // used = ceil(1001 / 4) = 251 → refund 249
    expect(settled?.coinsRefunded).toBe(249);
    expect(coins.refundCoins).toHaveBeenCalledWith(
      String(campaign.user),
      249,
      expect.any(String),
      expect.any(String),
    );
  });

  it('refunds everything when nothing was delivered', async () => {
    const campaign = base();
    const { service, coins } = setup({ campaign });

    await service.settle(
      campaign._id,
      CampaignStatus.CANCELLED,
      CampaignEndReason.CANCELLED_BY_USER,
    );
    expect(coins.refundCoins).toHaveBeenCalledWith(
      String(campaign.user),
      500,
      expect.any(String),
      expect.any(String),
    );
  });

  it('refunds nothing when the target was reached', async () => {
    const campaign = { ...base(), deliveredViews: 2000 };
    const { service, coins } = setup({ campaign });

    const settled = await service.settle(
      campaign._id,
      CampaignStatus.COMPLETED,
      CampaignEndReason.TARGET_REACHED,
    );
    expect(settled?.coinsRefunded).toBe(0);
    expect(coins.refundCoins).not.toHaveBeenCalled();
  });

  it('does nothing for a campaign that already ended', async () => {
    const campaign = { ...base(), status: CampaignStatus.EXPIRED };
    const { service, coins, campaignModel } = setup({ campaign });

    expect(
      await service.settle(
        campaign._id,
        CampaignStatus.CANCELLED,
        CampaignEndReason.CANCELLED_BY_USER,
      ),
    ).toBeNull();
    expect(campaignModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(coins.refundCoins).not.toHaveBeenCalled();
  });

  it('refunds only once when another caller wins the race', async () => {
    const campaign = base();
    const { service, coins, videoModel } = setup({
      campaign,
      settleWins: false,
    });

    expect(
      await service.settle(
        campaign._id,
        CampaignStatus.EXPIRED,
        CampaignEndReason.TIME_UP,
      ),
    ).toBeNull();
    expect(coins.refundCoins).not.toHaveBeenCalled();
    expect(videoModel.updateOne).not.toHaveBeenCalled();
  });

  it('clears the boosted flag only on the video this campaign owns', async () => {
    const campaign = base();
    const { service, videoModel } = setup({ campaign });

    await service.settle(
      campaign._id,
      CampaignStatus.EXPIRED,
      CampaignEndReason.TIME_UP,
    );
    expect(videoModel.updateOne).toHaveBeenCalledWith(
      { _id: campaign.video, activeCampaign: campaign._id },
      expect.objectContaining({ $unset: { activeCampaign: 1 } }),
    );
  });
});
