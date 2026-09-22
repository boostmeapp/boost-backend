import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  BoostCampaign,
  CampaignEndReason,
  CampaignStatus,
  LIVE_CAMPAIGN_STATUSES,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import {
  ModerationStatus,
  Video,
} from '../../database/schemas/video/video.schema';
import { BoostCampaignsService } from './boost-campaigns.service';

/**
 * Ends campaigns that ran out of time or lost their video. settle() is
 * idempotent, so overlapping runs (or a cancel mid-run) are harmless.
 */
@Injectable()
export class BoostCampaignsCron {
  private readonly logger = new Logger(BoostCampaignsCron.name);
  private running = false;

  constructor(
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
    @InjectModel(Video.name) private readonly videoModel: Model<Video>,
    private readonly campaigns: BoostCampaignsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const expired = await this.expireDue();
      const removed = await this.stopRemovedVideos();
      if (expired || removed) {
        this.logger.log(
          `Boost sweep: ${expired} expired, ${removed} stopped (video removed)`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Boost sweep failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
  }

  private async expireDue(): Promise<number> {
    const due = await this.campaignModel
      .find({
        status: { $in: LIVE_CAMPAIGN_STATUSES },
        endAt: { $lte: new Date() },
      })
      .select('_id')
      .lean();

    let count = 0;
    for (const c of due) {
      const settled = await this.campaigns.settle(
        c._id,
        CampaignStatus.EXPIRED,
        CampaignEndReason.TIME_UP,
      );
      if (settled) count++;
    }
    return count;
  }

  private async stopRemovedVideos(): Promise<number> {
    const live = await this.campaignModel
      .find({ status: { $in: LIVE_CAMPAIGN_STATUSES } })
      .select('_id video')
      .lean();
    if (!live.length) return 0;

    const present = await this.videoModel
      .find({
        _id: { $in: live.map((c) => c.video) },
        moderationStatus: { $ne: ModerationStatus.REMOVED },
      })
      .select('_id')
      .lean();
    const ok = new Set(present.map((v) => String(v._id)));

    let count = 0;
    for (const c of live.filter((l) => !ok.has(String(l.video)))) {
      const settled = await this.campaigns.settle(
        c._id,
        CampaignStatus.CANCELLED,
        CampaignEndReason.VIDEO_REMOVED,
      );
      if (settled) count++;
    }
    return count;
  }
}
