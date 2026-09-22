import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import {
  BoostCampaign,
  CampaignStatus,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { BoostImpression } from '../../database/schemas/boost-campaign/boost-impression.schema';
import { RedisService } from '../redis/redis.service';

export type EngagementKind = 'likes' | 'comments' | 'follows';

// Longest campaign, so a like → unlike → like loop still counts once.
const ENGAGEMENT_DEDUPE_SECONDS = 14 * 24 * 3600;

/**
 * Credits likes, comments and follows to a live campaign when they come from
 * someone the boost served. Called fire-and-forget from the likes, comments
 * and follows services — it never throws.
 */
@Injectable()
export class BoostEngagementService {
  private readonly logger = new Logger(BoostEngagementService.name);

  constructor(
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
    @InjectModel(BoostImpression.name)
    private readonly impressionModel: Model<BoostImpression>,
    private readonly redis: RedisService,
  ) {}

  /** A like or comment on `videoId` by `actorId`. */
  async onVideoEngagement(
    actorId: string,
    videoId: string,
    kind: 'likes' | 'comments',
  ) {
    try {
      const campaign = await this.campaignModel
        .findOne({
          video: new Types.ObjectId(videoId),
          status: CampaignStatus.ACTIVE,
        })
        .select('_id user')
        .lean();
      if (!campaign || String(campaign.user) === actorId) return;

      await this.credit(String(campaign._id), actorId, kind);
    } catch (err: any) {
      this.logger.warn(`Engagement (${kind}) failed: ${err?.message}`);
    }
  }

  /** `actorId` followed `creatorId`: credit that creator's live campaigns. */
  async onFollow(actorId: string, creatorId: string) {
    try {
      const campaigns = await this.campaignModel
        .find({
          user: new Types.ObjectId(creatorId),
          status: CampaignStatus.ACTIVE,
        })
        .select('_id')
        .lean();

      for (const c of campaigns) {
        await this.credit(String(c._id), actorId, 'follows');
      }
    } catch (err: any) {
      this.logger.warn(`Engagement (follows) failed: ${err?.message}`);
    }
  }

  private async credit(
    campaignId: string,
    actorId: string,
    kind: EngagementKind,
  ) {
    const served = await this.impressionModel.exists({
      campaign: new Types.ObjectId(campaignId),
      viewer: new Types.ObjectId(actorId),
    });
    if (!served) return;

    const first = await this.redis.setIfAbsent(
      `boost:eng:${campaignId}:${actorId}:${kind}`,
      ENGAGEMENT_DEDUPE_SECONDS,
    );
    if (!first) return;

    await this.campaignModel.updateOne(
      { _id: new Types.ObjectId(campaignId) },
      { $inc: { [`engagements.${kind}`]: 1 } },
    );
  }
}
