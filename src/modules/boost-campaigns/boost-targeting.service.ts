import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { createHash } from 'crypto';

import { User } from '../../database/schemas/user/user.schema';
import {
  CampaignTargeting,
  TargetAge,
  TargetGender,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { RedisService } from '../redis/redis.service';
import {
  AGE_OPTIONS,
  BOOST_CONFIG,
  PROFILE_GENDER_TO_TARGET,
} from './boost-campaigns.config';

/** The viewer fields targeting looks at. */
export interface TargetableViewer {
  _id: Types.ObjectId | string;
  dob?: Date;
  gender?: string;
  blockedUsers?: (Types.ObjectId | string)[];
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * Who a campaign may be shown to: people active in the last
 * ACTIVE_WINDOW_DAYS who match the age and gender filters. Audience size
 * doesn't change who is eligible — it sets what share of them the boost
 * targets (boost-reach.ts). Profile data is sparse (dob and gender are
 * optional), so a missing value never excludes anyone.
 */
@Injectable()
export class BoostTargetingService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly redis: RedisService,
  ) {}

  /** People the campaign could reach: active, matching, not the owner, not blocked. */
  async countEligible(
    targeting: CampaignTargeting,
    ownerId: string,
  ): Promise<number> {
    const key = `boost:audience:v3:${ownerId}:${this.hash(targeting)}`;

    try {
      const cached = await this.redis.getValue(key);
      if (cached !== null) return Number(cached);
    } catch {
      // Cache miss path below still works without Redis.
    }

    const owner = await this.userModel
      .findById(ownerId)
      .select('blockedUsers')
      .lean();
    const count = await this.userModel.countDocuments(
      this.audienceFilter(
        targeting,
        ownerId,
        (owner?.blockedUsers as Types.ObjectId[]) || [],
      ),
    );

    try {
      await this.redis.setValue(
        key,
        String(count),
        BOOST_CONFIG.AUDIENCE_COUNT_TTL_SECONDS,
      );
    } catch {
      // Best-effort cache.
    }

    return count;
  }

  /** In-memory twin of audienceFilter, used per feed request. */
  matchesViewer(
    targeting: CampaignTargeting,
    viewer: TargetableViewer,
  ): boolean {
    // The viewer is loading the feed, so they're active — only the profile
    // filters apply here.

    // Age (missing dob matches; "all" skips the check)
    if (viewer.dob && targeting.age !== TargetAge.ALL) {
      const bucket = AGE_OPTIONS.find((a) => a.key === targeting.age);
      const age = (Date.now() - new Date(viewer.dob).getTime()) / YEAR_MS;
      if (
        bucket &&
        (age < bucket.min || (bucket.max !== null && age >= bucket.max + 1))
      ) {
        return false;
      }
    }

    // Gender
    if (targeting.gender !== TargetGender.ALL) {
      const mapped = viewer.gender
        ? PROFILE_GENDER_TO_TARGET[viewer.gender]
        : undefined;
      if (mapped && mapped !== targeting.gender) return false;
    }

    return true;
  }

  private audienceFilter(
    targeting: CampaignTargeting,
    ownerId: string,
    ownerBlocked: Types.ObjectId[],
  ): Record<string, any> {
    const activeSince = new Date(
      Date.now() - BOOST_CONFIG.ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000,
    );

    // lastActiveAt is new, so users who haven't opened the app since it
    // shipped don't have it yet; they count until they get one.
    const and: Record<string, any>[] = [
      {
        $or: [
          { lastActiveAt: { $gte: activeSince } },
          { lastActiveAt: { $exists: false } },
        ],
      },
    ];

    // Either side of a block hides the video.
    const excluded = [new Types.ObjectId(ownerId), ...ownerBlocked];
    const filter: Record<string, any> = {
      isActive: true,
      _id: { $nin: excluded },
      blockedUsers: { $ne: new Types.ObjectId(ownerId) },
    };

    const bucket = AGE_OPTIONS.find((a) => a.key === targeting.age);
    if (bucket && targeting.age !== TargetAge.ALL) {
      const now = Date.now();
      const range: Record<string, Date> = {
        $lte: new Date(now - bucket.min * YEAR_MS),
      };
      if (bucket.max !== null)
        range.$gt = new Date(now - (bucket.max + 1) * YEAR_MS);
      and.push(this.orMissing('dob', range));
    }

    if (targeting.gender !== TargetGender.ALL) {
      const values = Object.entries(PROFILE_GENDER_TO_TARGET)
        .filter(([, target]) => target === targeting.gender)
        .map(([profile]) => profile);
      and.push(this.orMissing('gender', { $in: values }));
    }

    filter.$and = and;
    return filter;
  }

  /** `field matches`, or `field is not set` — missing data never excludes. */
  private orMissing(field: string, match: Record<string, any>) {
    return { $or: [{ [field]: match }, { [field]: { $in: [null, ''] } }] };
  }

  private hash(targeting: CampaignTargeting): string {
    const t = targeting;
    return createHash('sha1')
      .update(JSON.stringify([t.age, t.gender]))
      .digest('hex')
      .slice(0, 16);
  }
}
