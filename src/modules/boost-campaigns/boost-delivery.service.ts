import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import {
  BoostCampaign,
  CampaignStatus,
  CampaignTargeting,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { BoostImpression } from '../../database/schemas/boost-campaign/boost-impression.schema';
import { BoostView } from '../../database/schemas/boost-campaign/boost-view.schema';
import { User } from '../../database/schemas/user/user.schema';
import {
  ModerationStatus,
  Video,
  VideoProcessingStatus,
} from '../../database/schemas/video/video.schema';
import { RedisService } from '../redis/redis.service';
import {
  ACTIVE_CAMPAIGNS_CACHE_KEY,
  BOOST_CONFIG,
} from './boost-campaigns.config';
import {
  BoostTargetingService,
  TargetableViewer,
} from './boost-targeting.service';

/** The slice of an active campaign delivery needs, cached for a minute. */
interface CachedCampaign {
  id: string;
  video: string;
  owner: string;
  ownerBlocked: string[];
  targeting: CampaignTargeting;
  targetViews: number;
  deliveredViews: number;
  startAt: number;
  endAt: number;
}

export interface BoostPick {
  campaignId: string;
  video: any; // lean video with populated user
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Chooses which boosted videos a viewer sees and records that they saw them.
 * FeedService calls pickForViewer() per page and recordImpressions() for the
 * picks it actually injected.
 */
@Injectable()
export class BoostDeliveryService {
  private readonly logger = new Logger(BoostDeliveryService.name);

  constructor(
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
    @InjectModel(BoostImpression.name)
    private readonly impressionModel: Model<BoostImpression>,
    @InjectModel(BoostView.name) private readonly viewModel: Model<BoostView>,
    @InjectModel(Video.name) private readonly videoModel: Model<Video>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly targeting: BoostTargetingService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Up to `slots` campaigns for this viewer, most behind schedule first.
   * Never throws — a delivery problem must not break the feed.
   */
  async pickForViewer(
    viewerId: string,
    slots: number,
    excludeVideoIds: string[] = [],
    videoProjection = '',
    userProjection = '',
  ): Promise<BoostPick[]> {
    if (slots < 1) return [];

    try {
      const now = Date.now();
      const active = (await this.getActiveCampaigns()).filter(
        (c) =>
          c.startAt <= now && c.endAt > now && c.deliveredViews < c.targetViews,
      );
      if (!active.length) return [];

      const viewer = (await this.userModel
        .findById(viewerId)
        .select('dob gender blockedUsers')
        .lean()) as TargetableViewer | null;
      if (!viewer) return [];

      const viewerBlocked = new Set((viewer.blockedUsers || []).map(String));
      const excluded = new Set(excludeVideoIds);

      let candidates = active.filter(
        (c) =>
          c.owner !== viewerId &&
          !viewerBlocked.has(c.owner) &&
          !c.ownerBlocked.includes(viewerId) &&
          !excluded.has(c.video) &&
          this.targeting.matchesViewer(c.targeting, viewer),
      );
      if (!candidates.length) return [];

      const ids = candidates.map((c) => new Types.ObjectId(c.id));
      const viewerObj = new Types.ObjectId(viewerId);

      const [viewed, impressions] = await Promise.all([
        this.viewModel
          .find({ viewer: viewerObj, campaign: { $in: ids } })
          .select('campaign')
          .lean(),
        this.impressionModel
          .find({ viewer: viewerObj, campaign: { $in: ids } })
          .select('campaign servesDay servesToday lastServedAt')
          .lean(),
      ]);

      // Already counted for a campaign → nothing more to deliver to this viewer.
      const viewedSet = new Set(viewed.map((v) => String(v.campaign)));
      const today = utcDay();
      const cooldownMs = BOOST_CONFIG.MIN_MINUTES_BETWEEN_SERVES * 60 * 1000;
      const throttled = new Set(
        impressions
          .filter(
            (i) =>
              (i.servesDay === today &&
                i.servesToday >= BOOST_CONFIG.MAX_SERVES_PER_VIEWER_PER_DAY) ||
              now - new Date(i.lastServedAt).getTime() < cooldownMs,
          )
          .map((i) => String(i.campaign)),
      );

      candidates = candidates
        .filter((c) => !viewedSet.has(c.id) && !throttled.has(c.id))
        .sort((a, b) => this.behind(b, now) - this.behind(a, now));

      const chosen = candidates.slice(0, slots);
      if (!chosen.length) return [];

      const videos = await this.videoModel
        .find({
          _id: { $in: chosen.map((c) => new Types.ObjectId(c.video)) },
          processingStatus: VideoProcessingStatus.READY,
          moderationStatus: { $ne: ModerationStatus.REMOVED },
        })
        .select(videoProjection)
        .populate('user', userProjection)
        .lean();

      const byId = new Map(videos.map((v) => [String(v._id), v]));
      return chosen
        .filter((c) => byId.has(c.video))
        .map((c) => ({ campaignId: c.id, video: byId.get(c.video) }));
    } catch (err: any) {
      this.logger.warn(`Boost pick failed for ${viewerId}: ${err?.message}`);
      return [];
    }
  }

  /** Records that the viewer was served these campaigns. Best-effort. */
  async recordImpressions(viewerId: string, picks: BoostPick[]): Promise<void> {
    const now = new Date();
    const today = utcDay(now);
    const viewer = new Types.ObjectId(viewerId);

    await Promise.all(
      picks.map(async ({ campaignId, video }) => {
        try {
          const campaign = new Types.ObjectId(campaignId);

          // Pipeline update so the daily counter resets when the day changes.
          const res = await this.impressionModel.updateOne(
            { campaign, viewer },
            [
              {
                $set: {
                  campaign,
                  viewer,
                  video: video._id,
                  firstServedAt: { $ifNull: ['$firstServedAt', now] },
                  lastServedAt: now,
                  servesToday: {
                    $cond: [
                      { $eq: ['$servesDay', today] },
                      { $add: [{ $ifNull: ['$servesToday', 0] }, 1] },
                      1,
                    ],
                  },
                  servesDay: today,
                  totalServes: { $add: [{ $ifNull: ['$totalServes', 0] }, 1] },
                },
              },
            ],
            { upsert: true },
          );

          await this.campaignModel.updateOne(
            { _id: campaign },
            {
              $inc: { impressions: 1, uniqueReach: res.upsertedCount ? 1 : 0 },
            },
          );
        } catch (err: any) {
          this.logger.warn(
            `Impression write failed (${campaignId}/${viewerId}): ${err?.message}`,
          );
        }
      }),
    );
  }

  /** How far behind its even pace a campaign is, in views. Bigger = more urgent. */
  private behind(c: CachedCampaign, now: number): number {
    const elapsed = Math.min(
      1,
      Math.max(0, (now - c.startAt) / (c.endAt - c.startAt)),
    );
    return c.targetViews * elapsed - c.deliveredViews;
  }

  private async getActiveCampaigns(): Promise<CachedCampaign[]> {
    try {
      const cached = await this.redis.getValue(ACTIVE_CAMPAIGNS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      // Fall through to Mongo.
    }

    const rows = await this.campaignModel
      .find({ status: CampaignStatus.ACTIVE, endAt: { $gt: new Date() } })
      .select('video user targeting targetViews deliveredViews startAt endAt')
      .lean();

    const owners = await this.userModel
      .find({ _id: { $in: [...new Set(rows.map((r) => String(r.user)))] } })
      .select('blockedUsers')
      .lean();
    const blockedByOwner = new Map(
      owners.map((o) => [String(o._id), (o.blockedUsers || []).map(String)]),
    );

    const list: CachedCampaign[] = rows.map((r) => ({
      id: String(r._id),
      video: String(r.video),
      owner: String(r.user),
      ownerBlocked: blockedByOwner.get(String(r.user)) || [],
      targeting: r.targeting,
      targetViews: r.targetViews,
      deliveredViews: r.deliveredViews,
      startAt: new Date(r.startAt).getTime(),
      endAt: new Date(r.endAt).getTime(),
    }));

    try {
      await this.redis.setValue(
        ACTIVE_CAMPAIGNS_CACHE_KEY,
        JSON.stringify(list),
        BOOST_CONFIG.ACTIVE_CAMPAIGNS_TTL_SECONDS,
      );
    } catch {
      // Uncached is fine at this scale.
    }

    return list;
  }
}
