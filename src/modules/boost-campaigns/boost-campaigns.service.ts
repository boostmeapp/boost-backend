import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import {
  BoostCampaign,
  CampaignEndReason,
  CampaignGoal,
  CampaignStatus,
  LIVE_CAMPAIGN_STATUSES,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import {
  ModerationStatus,
  Video,
  VideoProcessingStatus,
} from '../../database/schemas/video/video.schema';
import { ENV } from '../../config';
import { CoinsService } from '../coins/coins.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { RedisService } from '../redis/redis.service';
import { MediaUrlService } from '../../common/services/media-url.service';
import {
  ACTIVE_CAMPAIGNS_CACHE_KEY,
  AGE_OPTIONS,
  AUDIENCE_SIZE_OPTIONS,
  BOOST_CONFIG,
  BOOST_TIERS,
  GENDER_OPTIONS,
} from './boost-campaigns.config';
import { BoostTargetingService } from './boost-targeting.service';
import { calculateReach } from './boost-reach';
import {
  CreateCampaignDto,
  EstimateCampaignDto,
  ListCampaignsQueryDto,
} from './dto';

const TAB_STATUSES: Record<string, CampaignStatus[]> = {
  live: LIVE_CAMPAIGN_STATUSES,
  past: [CampaignStatus.COMPLETED, CampaignStatus.EXPIRED],
  cancelled: [CampaignStatus.CANCELLED],
};

const DAY_MS = 24 * 3600 * 1000;

@Injectable()
export class BoostCampaignsService {
  private readonly logger = new Logger(BoostCampaignsService.name);

  constructor(
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
    @InjectModel(Video.name) private readonly videoModel: Model<Video>,
    private readonly targeting: BoostTargetingService,
    private readonly coinsService: CoinsService,
    private readonly notificationService: NotificationService,
    private readonly redis: RedisService,
    private readonly mediaUrl: MediaUrlService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Config + estimate                                                   */
  /* ------------------------------------------------------------------ */

  getConfig() {
    return {
      coins: {
        min: BOOST_CONFIG.COINS_MIN,
        max: BOOST_CONFIG.COINS_MAX,
        step: BOOST_CONFIG.COINS_STEP,
        tiers: BOOST_TIERS,
      },
      durations: BOOST_CONFIG.DURATIONS,
      viewsPerCoin: ENV.BOOST_VIEWS_PER_COIN,
      audienceSizes: AUDIENCE_SIZE_OPTIONS,
      ages: AGE_OPTIONS.map(({ key, label }) => ({ key, label })),
      genders: GENDER_OPTIONS,
      goals: [{ key: CampaignGoal.VIEWS, label: 'More Video Views' }],
    };
  }

  /**
   * What `coins` buys for this targeting. A viewer counts once per campaign,
   * so delivery can never exceed the eligible audience — the target is capped
   * there and only the coins that target needs are charged.
   */
  async estimate(ownerId: string, dto: EstimateCampaignDto) {
    const viewsPerCoin = ENV.BOOST_VIEWS_PER_COIN;
    const targeting = this.normaliseTargeting(dto.targeting);
    const eligibleAudience = await this.targeting.countEligible(
      targeting,
      ownerId,
    );

    const reach = calculateReach({
      eligibleAudience,
      audienceSize: targeting.audienceSize,
      coins: dto.coins,
      viewsPerCoin,
    });

    return {
      targeting,
      durationDays: dto.durationDays,
      viewsPerCoin,
      eligibleAudience,

      // See boost-reach.ts for the formulas.
      audienceReach: reach.audienceReach,
      requestedViews: reach.requestedViews,
      finalReach: reach.finalReach,
      coinsRequested: dto.coins,
      coinsCharged: reach.coinsRequired,
      maxUsefulCoins: Math.min(
        BOOST_CONFIG.COINS_MAX,
        Math.ceil(reach.audienceReach / viewsPerCoin),
      ),

      // Kept for app builds that read the old field names.
      targetViews: reach.finalReach,
      wantedViews: reach.requestedViews,
      estimatedReach: { min: reach.finalReach, max: reach.finalReach },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Create                                                              */
  /* ------------------------------------------------------------------ */

  async create(
    ownerId: string,
    dto: CreateCampaignDto,
    idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 128) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }

    // A retried request returns the campaign it already created.
    const existing = await this.campaignModel.findOne({
      user: new Types.ObjectId(ownerId),
      idempotencyKey: key,
    });
    if (existing) {
      const { coinBalance } = await this.coinsService.getBalance(ownerId);
      return {
        campaign: this.present(existing),
        coinsCharged: existing.coinsCharged,
        coinBalance,
      };
    }

    const video = await this.videoModel
      .findById(dto.videoId)
      .select('user processingStatus moderationStatus')
      .lean();
    if (!video) throw new NotFoundException('VIDEO_NOT_FOUND');
    if (String(video.user) !== ownerId)
      throw new ForbiddenException('NOT_VIDEO_OWNER');
    if (
      video.processingStatus !== VideoProcessingStatus.READY ||
      video.moderationStatus === ModerationStatus.REMOVED
    ) {
      throw new BadRequestException('VIDEO_NOT_READY');
    }

    const live = await this.campaignModel.exists({
      video: video._id,
      status: { $in: LIVE_CAMPAIGN_STATUSES },
    });
    if (live) throw new ConflictException('ACTIVE_CAMPAIGN_EXISTS');

    const quote = await this.estimate(ownerId, dto);
    if (quote.targetViews < 1)
      throw new BadRequestException('NO_ELIGIBLE_AUDIENCE');

    // The id is minted first so the coin ledger row can reference it.
    const campaignId = new Types.ObjectId();
    const { coinBalance } = await this.coinsService.spendCoins(
      ownerId,
      quote.coinsCharged,
      `Boost campaign (${quote.targetViews} views, ${dto.durationDays}d)`,
      `boost_campaign:${campaignId}`,
    );

    const startAt = new Date();
    let campaign: BoostCampaign;

    try {
      campaign = await this.campaignModel.create({
        _id: campaignId,
        user: new Types.ObjectId(ownerId),
        video: video._id,
        goal: dto.goal ?? CampaignGoal.VIEWS,
        targeting: quote.targeting,
        coinsRequested: dto.coins,
        coinsCharged: quote.coinsCharged,
        viewsPerCoin: quote.viewsPerCoin,
        targetViews: quote.targetViews,
        eligibleAudienceAtStart: quote.eligibleAudience,
        status: CampaignStatus.ACTIVE,
        durationDays: dto.durationDays,
        startAt,
        endAt: new Date(startAt.getTime() + dto.durationDays * DAY_MS),
        idempotencyKey: key,
      });
    } catch (err: any) {
      // No multi-document transactions here, so undo the spend by hand.
      await this.coinsService.refundCoins(
        ownerId,
        quote.coinsCharged,
        'Boost campaign could not be created — coins returned',
        `boost_campaign:${campaignId}`,
      );

      if (err?.code === 11000) {
        // Lost a race: either the same idempotency key or a second live campaign.
        const raced = await this.campaignModel.findOne({
          user: new Types.ObjectId(ownerId),
          idempotencyKey: key,
        });
        if (raced) {
          const bal = await this.coinsService.getBalance(ownerId);
          return {
            campaign: this.present(raced),
            coinsCharged: raced.coinsCharged,
            coinBalance: bal.coinBalance,
          };
        }
        throw new ConflictException('ACTIVE_CAMPAIGN_EXISTS');
      }
      throw err;
    }

    await this.videoModel.updateOne(
      { _id: video._id },
      {
        isBoosted: true,
        activeCampaign: campaign._id,
        boostStartDate: campaign.startAt,
        boostEndDate: campaign.endAt,
      },
    );
    await this.invalidateActiveCache();

    void this.notificationService.notify({
      users: ownerId,
      type: NotificationType.Boost,
      title: 'Your boost is live',
      body: `We'll show your video to up to ${campaign.targetViews.toLocaleString('en-US')} people over ${this.days(campaign.durationDays)}.`,
      metadata: {
        campaignId: String(campaign._id),
        videoId: String(video._id),
      },
    });

    return {
      campaign: this.present(campaign),
      coinsCharged: quote.coinsCharged,
      coinBalance,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Reads                                                               */
  /* ------------------------------------------------------------------ */

  async list(ownerId: string, query: ListCampaignsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter = {
      user: new Types.ObjectId(ownerId),
      status: { $in: TAB_STATUSES[query.tab ?? 'live'] },
    };

    const [rows, total] = await Promise.all([
      this.campaignModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('video', 'title thumbnailUrl thumbnailKey duration')
        .lean(),
      this.campaignModel.countDocuments(filter),
    ]);

    return {
      data: rows.map((c) => this.present(c)),
      meta: { page, limit, total, hasNextPage: page * limit < total },
    };
  }

  async findOne(ownerId: string, id: string) {
    const campaign = await this.getOwned(ownerId, id, true);
    return this.present(campaign);
  }

  /* ------------------------------------------------------------------ */
  /*  Cancel / pause / resume                                             */
  /* ------------------------------------------------------------------ */

  async cancel(ownerId: string, id: string) {
    const campaign = await this.getOwned(ownerId, id);
    if (!LIVE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new BadRequestException('CAMPAIGN_NOT_LIVE');
    }

    const settled = await this.settle(
      campaign._id,
      CampaignStatus.CANCELLED,
      CampaignEndReason.CANCELLED_BY_USER,
    );
    const { coinBalance } = await this.coinsService.getBalance(ownerId);

    return {
      campaign: this.present(settled ?? campaign),
      refundedCoins: settled?.coinsRefunded ?? 0,
      coinBalance,
    };
  }

  async pause(ownerId: string, id: string) {
    return this.transition(
      ownerId,
      id,
      CampaignStatus.ACTIVE,
      CampaignStatus.PAUSED,
    );
  }

  async resume(ownerId: string, id: string) {
    const campaign = await this.getOwned(ownerId, id);
    if (campaign.endAt <= new Date())
      throw new BadRequestException('CAMPAIGN_ENDED');
    return this.transition(
      ownerId,
      id,
      CampaignStatus.PAUSED,
      CampaignStatus.ACTIVE,
    );
  }

  private async transition(
    ownerId: string,
    id: string,
    from: CampaignStatus,
    to: CampaignStatus,
  ) {
    await this.getOwned(ownerId, id);
    const updated = await this.campaignModel.findOneAndUpdate(
      { _id: id, status: from },
      { status: to },
      { new: true },
    );
    if (!updated)
      throw new BadRequestException(`CAMPAIGN_NOT_${from.toUpperCase()}`);

    await this.invalidateActiveCache();
    return this.present(updated);
  }

  /* ------------------------------------------------------------------ */
  /*  Settlement                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Ends a live campaign exactly once and refunds the undelivered share:
   *   refund = coinsCharged − ceil(deliveredViews / viewsPerCoin)
   * Returns null when another caller already settled it.
   */
  async settle(
    campaignId: Types.ObjectId | string,
    status: CampaignStatus,
    reason: CampaignEndReason,
  ): Promise<BoostCampaign | null> {
    const current = await this.campaignModel.findById(campaignId).lean();
    if (!current || !LIVE_CAMPAIGN_STATUSES.includes(current.status))
      return null;

    const coinsUsed = Math.min(
      current.coinsCharged,
      Math.ceil(current.deliveredViews / current.viewsPerCoin),
    );
    const refund = Math.max(0, current.coinsCharged - coinsUsed);
    const endedAt = new Date();

    // The status guard makes this the single winner if the cron, a cancel and
    // the final view all race to end the same campaign.
    const settled = await this.campaignModel.findOneAndUpdate(
      { _id: campaignId, status: { $in: LIVE_CAMPAIGN_STATUSES } },
      { status, endReason: reason, endedAt, coinsRefunded: refund },
      { new: true },
    );
    if (!settled) return null;

    if (refund > 0) {
      try {
        await this.coinsService.refundCoins(
          String(settled.user),
          refund,
          `Boost refund: ${refund} undelivered coins`,
          `boost_campaign:${settled._id}`,
        );
      } catch (err: any) {
        // The campaign already records coinsRefunded; this needs a manual credit.
        this.logger.error(
          `Refund of ${refund} coins failed for campaign ${settled._id}: ${err?.message}`,
        );
      }
    }

    await this.videoModel.updateOne(
      { _id: settled.video, activeCampaign: settled._id },
      {
        $set: { isBoosted: false, boostScore: 0, boostEndDate: endedAt },
        $unset: { activeCampaign: 1 },
      },
    );
    await this.invalidateActiveCache();

    this.notifyEnded(settled);
    return settled;
  }

  private notifyEnded(c: BoostCampaign) {
    const views = c.deliveredViews.toLocaleString('en-US');
    const refundNote =
      c.coinsRefunded > 0 ? ` ${c.coinsRefunded} coins refunded.` : '';

    const copy: Record<CampaignEndReason, { title: string; body: string }> = {
      [CampaignEndReason.TARGET_REACHED]: {
        title: 'Your boost hit its goal 🎉',
        body: `Your video reached ${views} people.`,
      },
      [CampaignEndReason.TIME_UP]: {
        title: 'Your boost has finished',
        body: `Your video reached ${views} people.${refundNote}`,
      },
      [CampaignEndReason.CANCELLED_BY_USER]: {
        title: 'Boost cancelled',
        body: `Your video reached ${views} people.${refundNote}`,
      },
      [CampaignEndReason.VIDEO_REMOVED]: {
        title: 'Boost stopped',
        body: `The boosted video is no longer available.${refundNote}`,
      },
    };

    const message = copy[c.endReason as CampaignEndReason];
    if (!message) return;

    void this.notificationService.notify({
      users: String(c.user),
      type: NotificationType.Boost,
      ...message,
      metadata: { campaignId: String(c._id), videoId: String(c.video) },
    });
  }

  async invalidateActiveCache() {
    try {
      await this.redis.delValue(ACTIVE_CAMPAIGNS_CACHE_KEY);
    } catch {
      // Cache expires on its own within a minute.
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private async getOwned(ownerId: string, id: string, populate = false) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('CAMPAIGN_NOT_FOUND');

    const q = this.campaignModel.findById(id);
    if (populate)
      q.populate('video', 'title thumbnailUrl thumbnailKey duration');
    const campaign = await q.exec();

    if (!campaign) throw new NotFoundException('CAMPAIGN_NOT_FOUND');
    if (String(campaign.user) !== ownerId)
      throw new ForbiddenException('NOT_CAMPAIGN_OWNER');
    return campaign;
  }

  // Copies only known fields, so nothing extra is ever persisted.
  private normaliseTargeting(t: EstimateCampaignDto['targeting']) {
    return { audienceSize: t.audienceSize, age: t.age, gender: t.gender };
  }

  private days(n: number) {
    return `${n} ${n === 1 ? 'day' : 'days'}`;
  }

  /** Wire format for the app, including the dashboard's derived numbers. */
  present(doc: any) {
    const c = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const now = Date.now();
    const start = new Date(c.startAt).getTime();
    const end = new Date(c.endedAt ?? c.endAt).getTime();
    const plannedEnd = new Date(c.endAt).getTime();

    const coinsSpent = Math.min(
      c.coinsCharged,
      Math.ceil(c.deliveredViews / c.viewsPerCoin),
    );
    const elapsed = Math.min(
      1,
      Math.max(0, (Math.min(now, plannedEnd) - start) / (plannedEnd - start)),
    );
    const expected = c.targetViews * elapsed;

    let pace: 'optimal' | 'behind' | 'completed' | 'paused' | 'ended' =
      'optimal';
    if (c.status === CampaignStatus.COMPLETED) pace = 'completed';
    else if (c.status === CampaignStatus.PAUSED) pace = 'paused';
    else if (!LIVE_CAMPAIGN_STATUSES.includes(c.status)) pace = 'ended';
    else if (c.deliveredViews < expected * 0.8) pace = 'behind';

    const video =
      c.video && typeof c.video === 'object' && 'title' in c.video
        ? {
            _id: c.video._id,
            title: c.video.title,
            duration: c.video.duration,
            thumbnailUrl: this.mediaUrl.toUrl(
              c.video.thumbnailKey || c.video.thumbnailUrl,
            ),
          }
        : c.video;

    return {
      _id: c._id,
      video,
      goal: c.goal,
      targeting: c.targeting,
      status: c.status,
      endReason: c.endReason ?? null,
      durationDays: c.durationDays,
      startAt: c.startAt,
      endAt: c.endAt,
      endedAt: c.endedAt ?? null,
      remainingMs: LIVE_CAMPAIGN_STATUSES.includes(c.status)
        ? Math.max(0, plannedEnd - now)
        : 0,
      createdAt: c.createdAt,

      coinsRequested: c.coinsRequested,
      coinsCharged: c.coinsCharged,
      coinsSpent,
      coinsRefunded: c.coinsRefunded,

      targetViews: c.targetViews,
      deliveredViews: c.deliveredViews,
      progress: c.targetViews
        ? Math.min(1, c.deliveredViews / c.targetViews)
        : 0,
      impressions: c.impressions,
      uniqueReach: c.uniqueReach,
      engagements: c.engagements,
      engagementTotal:
        (c.engagements?.likes ?? 0) +
        (c.engagements?.comments ?? 0) +
        (c.engagements?.follows ?? 0),
      avgCoinsPerView: c.deliveredViews
        ? Number((coinsSpent / c.deliveredViews).toFixed(3))
        : null,
      pace,
      activeDurationMs: Math.max(0, end - start),
    };
  }
}
