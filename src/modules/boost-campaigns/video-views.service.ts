import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import {
  BoostCampaign,
  CampaignEndReason,
  CampaignStatus,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { BoostImpression } from '../../database/schemas/boost-campaign/boost-impression.schema';
import { BoostView } from '../../database/schemas/boost-campaign/boost-view.schema';
import { User } from '../../database/schemas/user/user.schema';
import {
  ModerationStatus,
  Video,
} from '../../database/schemas/video/video.schema';
import { RedisService } from '../redis/redis.service';
import { BOOST_CONFIG } from './boost-campaigns.config';
import { BoostCampaignsService } from './boost-campaigns.service';
import { BoostTargetingService } from './boost-targeting.service';

const VIEW_DEDUPE_SECONDS = 24 * 3600;
const WATCH_SLACK_SECONDS = 5;

/**
 * POST /videos/:id/views — the one place views are counted.
 *
 *  1. viewCount: once per viewer (or device, for guests) per video per 24h.
 *  2. Campaign delivery: a view of a video with a live boost counts toward
 *     it, wherever it was watched (feed card, boost slot, profile, full
 *     screen), once per signed-in viewer who matches the boost's audience.
 *     See docs/boost-campaigns/README.md §4.
 *
 * Every rejection is silent: the endpoint always answers 204 so it can't be
 * used to probe what counts.
 */
@Injectable()
export class VideoViewsService {
  private readonly logger = new Logger(VideoViewsService.name);

  constructor(
    @InjectModel(Video.name) private readonly videoModel: Model<Video>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
    @InjectModel(BoostImpression.name)
    private readonly impressionModel: Model<BoostImpression>,
    @InjectModel(BoostView.name) private readonly viewModel: Model<BoostView>,
    private readonly campaigns: BoostCampaignsService,
    private readonly targeting: BoostTargetingService,
    private readonly redis: RedisService,
  ) {}

  async report(
    videoId: string,
    input: { watchSeconds: number; campaignId?: string },
    viewerId?: string,
    deviceId?: string,
  ): Promise<void> {
    const who = viewerId || (deviceId ? `d:${deviceId.slice(0, 64)}` : null);
    if (!who || !Types.ObjectId.isValid(videoId)) return;

    try {
      const reports = await this.redis.incrWithTtl(`viewrate:${who}`, 60);
      if (reports > BOOST_CONFIG.MAX_VIEW_REPORTS_PER_MINUTE) return;

      const video = await this.videoModel
        .findById(videoId)
        .select('user duration moderationStatus')
        .lean();
      if (!video || video.moderationStatus === ModerationStatus.REMOVED) return;
      if (viewerId && String(video.user) === viewerId) return; // own views don't count

      const duration = Number(video.duration) || 0;
      const threshold =
        duration > 0
          ? Math.min(BOOST_CONFIG.QUALIFIED_VIEW_SECONDS, duration / 2)
          : BOOST_CONFIG.QUALIFIED_VIEW_SECONDS;
      const watched = Number(input.watchSeconds) || 0;
      if (watched < threshold) return;

      await this.countView(video._id, who, watched, duration);

      // The live boost is looked up from the video, so a view counts no matter
      // which screen it came from. `input.campaignId` is accepted for older
      // app builds but no longer needed.
      if (viewerId) {
        await this.attribute(video, viewerId, watched, duration);
      }
    } catch (err: any) {
      this.logger.warn(
        `View report failed (${videoId}/${who}): ${err?.message}`,
      );
    }
  }

  private async countView(
    videoId: Types.ObjectId,
    who: string,
    watched: number,
    duration: number,
  ) {
    const first = await this.redis.setIfAbsent(
      `view:${videoId}:${who}`,
      VIEW_DEDUPE_SECONDS,
    );
    if (!first) return;

    const seconds =
      duration > 0
        ? Math.min(watched, duration + WATCH_SLACK_SECONDS)
        : watched;
    await this.videoModel.updateOne(
      { _id: videoId },
      { $inc: { viewCount: 1, watchTimeTotal: Math.round(seconds) } },
    );
  }

  private async attribute(
    video: { _id: Types.ObjectId; user: Types.ObjectId },
    viewerId: string,
    watched: number,
    duration: number,
  ) {
    // Watching longer than the video (plus slack) isn't possible.
    if (duration > 0 && watched > duration + WATCH_SLACK_SECONDS) return;

    const campaign = await this.campaignModel
      .findOne({
        video: video._id,
        status: CampaignStatus.ACTIVE,
        endAt: { $gt: new Date() },
      })
      .select('video user targeting endAt targetViews deliveredViews')
      .lean();
    if (!campaign) return;

    const viewerDoc = await this.userModel
      .findById(viewerId)
      .select('dob gender blockedUsers')
      .lean();
    if (!viewerDoc) return;

    // Only the audience the owner paid for counts.
    if (!this.targeting.matchesViewer(campaign.targeting, viewerDoc)) return;
    if (await this.isBlockedEitherWay(viewerId, String(campaign.user))) return;

    const viewer = new Types.ObjectId(viewerId);

    try {
      await this.viewModel.create({
        campaign: campaign._id,
        viewer,
        video: video._id,
        watchSeconds: Math.round(watched),
      });
    } catch (err: any) {
      if (err?.code === 11000) return; // already counted for this campaign
      throw err;
    }

    // A view outside a boost slot still reached this person, so make sure
    // they're in the campaign's reach numbers.
    const now = new Date();
    const imp = await this.impressionModel.updateOne(
      { campaign: campaign._id, viewer },
      {
        $setOnInsert: {
          video: video._id,
          firstServedAt: now,
          lastServedAt: now,
          servesDay: now.toISOString().slice(0, 10),
          servesToday: 0,
          totalServes: 0,
        },
      },
      { upsert: true },
    );
    if (imp.upsertedCount) {
      await this.campaignModel.updateOne(
        { _id: campaign._id },
        { $inc: { uniqueReach: 1 } },
      );
    }

    // Guarded increment: concurrent views at the boundary can't overshoot.
    const updated = await this.campaignModel.findOneAndUpdate(
      {
        _id: campaign._id,
        status: CampaignStatus.ACTIVE,
        $expr: { $lt: ['$deliveredViews', '$targetViews'] },
      },
      { $inc: { deliveredViews: 1 } },
      { new: true },
    );

    if (updated && updated.deliveredViews >= updated.targetViews) {
      await this.campaigns.settle(
        updated._id,
        CampaignStatus.COMPLETED,
        CampaignEndReason.TARGET_REACHED,
      );
    }
  }

  private async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const hit = await this.userModel.exists({
      $or: [
        { _id: new Types.ObjectId(a), blockedUsers: new Types.ObjectId(b) },
        { _id: new Types.ObjectId(b), blockedUsers: new Types.ObjectId(a) },
      ],
    });
    return !!hit;
  }
}
