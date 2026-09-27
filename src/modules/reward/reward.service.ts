import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { VideoReward } from '../../database/schemas/reward/video-reward.schema';
import {
  UserEarning,
  UserRewardBalance,
  RewardPoolStats,
} from '../../database/schemas/reward/user-earning.schema';
import { Video } from '../../database/schemas/video/video.schema';
import { Boost, REWARD_CONFIG } from '../../database/schemas/boost/boost.schema';
import { TransactionService } from '../transaction/transaction.service';
import { TransactionType, TransactionStatus, PaymentMethod } from '../../database/schemas/transaction/transaction.schema';
import { WalletService } from '../wallet/wallet.service';
import { ENV } from '../../config';

@Injectable()
export class RewardService {
  // View qualification requirements
  private readonly MIN_WATCH_SECONDS = 10; // Must watch at least 10 seconds
  private readonly MIN_WATCH_PERCENTAGE = 30; // OR at least 30% of video
  private readonly FIXED_REWARD_PER_VIEW = REWARD_CONFIG.FIXED_REWARD_PER_VIEW; // €0.0003

  constructor(
    @InjectModel(VideoReward.name) private videoRewardModel: Model<VideoReward>,
    @InjectModel(UserEarning.name) private userEarningModel: Model<UserEarning>,
    @InjectModel(UserRewardBalance.name) private userRewardBalanceModel: Model<UserRewardBalance>,
    @InjectModel(RewardPoolStats.name) private rewardPoolStatsModel: Model<RewardPoolStats>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(Boost.name) private boostModel: Model<Boost>,
    private transactionService: TransactionService,
      private walletService: WalletService, 
  ) {}

/**
 * Opens a viewer reward pool for a campaign-boosted video.
 *
 * The campaign module charges in coins, while the pool — and every reward
 * paid from it — is denominated in the reward currency, so the coins are
 * converted here at ENV.COIN_VALUE. Doing it at this boundary keeps the
 * conversion in one place; recordVideoWatch stays currency-only.
 *
 * `sourceId` is the campaign, stored on VideoReward.boost the same way a
 * legacy boost id is: one pool per boost of either kind.
 */
async createCampaignReward(
  campaignId: string,
  videoId: string,
  coinsCharged: number,
): Promise<VideoReward | null> {
  const poolCurrency = coinsCharged * ENV.COIN_VALUE;
  const totalRewardPool = poolCurrency * REWARD_CONFIG.REWARD_POOL_PERCENTAGE;

  // Below one reward, a pool could never pay anyone; leave hasRewardPool
  // false so recordVideoWatch reports honestly rather than "pool depleted".
  if (totalRewardPool < this.FIXED_REWARD_PER_VIEW) {
    return null;
  }

  const videoReward = new this.videoRewardModel({
    video: new Types.ObjectId(videoId),
    boost: new Types.ObjectId(campaignId),
    totalRewardPool,
    distributedRewards: 0,
    remainingRewards: totalRewardPool,
    rewardPerView: this.FIXED_REWARD_PER_VIEW,
    totalViews: 0,
    eligibleViews: 0,
    isActive: true,
  });

  await this.updateGlobalStats(totalRewardPool, 0);
  return videoReward.save();
}

/**
 * Suspends or resumes a campaign's pool, following pause/resume.
 *
 * A paused campaign stops being delivered, but the video keeps its organic
 * audience — without this the pool would go on paying for views the
 * advertiser is no longer buying.
 *
 * Resuming will not revive a pool that ran dry: `remainingRewards` is the
 * real limit, and a depleted pool was deactivated by recordVideoWatch.
 * Returns whether a pool is active afterwards, so the caller can keep
 * video.hasRewardPool in step.
 */
async setCampaignRewardActive(
  campaignId: string,
  isActive: boolean,
): Promise<boolean> {
  const filter: Record<string, unknown> = {
    boost: new Types.ObjectId(campaignId),
  };
  if (isActive) filter.remainingRewards = { $gte: this.FIXED_REWARD_PER_VIEW };

  const result = await this.videoRewardModel
    .updateOne(filter, { $set: { isActive } })
    .exec();

  return isActive && result.matchedCount > 0;
}

/**
 * Closes a campaign's pool when the boost ends or is cancelled.
 *
 * Rewards already paid are not clawed back — the views happened. The unspent
 * remainder simply stops being payable, which matches the coin refund the
 * campaign issues for undelivered views.
 */
async closeCampaignReward(campaignId: string): Promise<void> {
  await this.videoRewardModel
    .updateOne(
      { boost: new Types.ObjectId(campaignId), isActive: true },
      { $set: { isActive: false } },
    )
    .exec();
}

async createVideoReward(boostId: string, videoId: string): Promise<VideoReward> {
  const boost = await this.boostModel.findById(boostId).exec();
  if (!boost) {
    throw new NotFoundException('Boost not found');
  }

  const video = await this.videoModel.findById(videoId).exec();
  if (!video) {
    throw new NotFoundException('Video not found');
  }

  // ❗ OPTIONAL safety (agar chaho)
  if (!video.isBoosted) {
    throw new BadRequestException(
      'Reward only for boosted video',
    );
  }

  const totalRewardPool =
    boost.amount * REWARD_CONFIG.REWARD_POOL_PERCENTAGE;

  const videoReward = new this.videoRewardModel({
    video: new Types.ObjectId(videoId),
    boost: new Types.ObjectId(boostId),
    totalRewardPool,
    distributedRewards: 0,
    remainingRewards: totalRewardPool,
    rewardPerView: this.FIXED_REWARD_PER_VIEW,
    totalViews: 0,
    eligibleViews: 0,
    isActive: true,
  });

  await this.updateGlobalStats(totalRewardPool, 0);
  return videoReward.save();
}


  async recordVideoWatch(
    userId: string,
    videoId: string,
    watchDuration: number,
  ): Promise<{ earned: boolean; amount?: number; message: string }> {
    // Check if user is the video owner
    const video = await this.videoModel.findById(videoId).exec();
    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.user.toString() === userId) {
      return {
        earned: false,
        message: 'You cannot earn rewards from your own videos',
      };
    }

    // Check if video has active reward pool
    if (!video.hasRewardPool || !video.isBoosted) {
      return {
        earned: false,
        message: 'This video does not have an active reward pool',
      };
    }

    // Check if user already earned from this video
    const existingEarning = await this.userEarningModel
      .findOne({
        user: new Types.ObjectId(userId),
        video: new Types.ObjectId(videoId),
      })
      .exec();

    if (existingEarning) {
      return {
        earned: false,
        message: 'You already earned rewards from this video',
      };
    }

    // Calculate watch percentage
    const watchPercentage = (watchDuration / video.duration) * 100;

    // Check if user watched enough to earn (≥10 seconds OR ≥30%)
    const meetsTimeRequirement = watchDuration >= this.MIN_WATCH_SECONDS;
    const meetsPercentageRequirement = watchPercentage >= this.MIN_WATCH_PERCENTAGE;

    if (!meetsTimeRequirement && !meetsPercentageRequirement) {
      return {
        earned: false,
        message: `You must watch at least ${this.MIN_WATCH_SECONDS} seconds or ${this.MIN_WATCH_PERCENTAGE}% of the video to earn rewards`,
      };
    }

    // Get video reward pool
    const videoReward = await this.videoRewardModel
      .findOne({
        video: new Types.ObjectId(videoId),
        isActive: true,
      })
      .exec();

    if (!videoReward) {
      return {
        earned: false,
        message: 'Reward pool is no longer active',
      };
    }

    // Check if reward pool has enough funds for this reward
    // Must never pay beyond the available pool
    const earnedAmount = this.FIXED_REWARD_PER_VIEW;

    if (videoReward.remainingRewards < earnedAmount) {
      // Pool depleted - auto-disable boost
      await this.disableBoostAndRewards(videoId, videoReward._id);

      return {
        earned: false,
        message: 'Reward pool is depleted',
      };
    }

    // Create earning record
    const earning = new this.userEarningModel({
      user: new Types.ObjectId(userId),
      video: new Types.ObjectId(videoId),
      videoReward: videoReward._id,
      amount: earnedAmount,
      watchDuration,
      videoDuration: video.duration,
      watchPercentage,
    });

    await earning.save();

    // Update video reward pool
    videoReward.distributedRewards += earnedAmount;
    videoReward.remainingRewards -= earnedAmount;
    videoReward.eligibleViews += 1;

    // Check if pool is now depleted (reached €0)
    const poolDepleted = videoReward.remainingRewards <= 0;

    if (poolDepleted) {
      videoReward.isActive = false;
    }

    await videoReward.save();

    // Update video stats
    await this.videoModel.findByIdAndUpdate(videoId, {
      $inc: {
        rewardPoolDistributed: earnedAmount,
        rewardEligibleViews: 1,
      },
    });

    // If pool depleted, auto-disable boost
    if (poolDepleted) {
      await this.disableBoostAndRewards(videoId, videoReward._id);
    }

    // Update user reward balance
// Update reward balance (analytics / stats)

const updatedBalance = await this.updateUserRewardBalance(userId, earnedAmount);
await this.walletService.addEarnings(userId, earnedAmount);


    // Update global stats
    await this.updateGlobalStats(0, earnedAmount);

    // Create transaction record for the reward earning
    await this.transactionService.create({
      userId,
      type: TransactionType.REWARD_EARNED,
      amount: earnedAmount,
      balanceBefore: updatedBalance.availableBalance - earnedAmount,
      balanceAfter: updatedBalance.availableBalance,
      paymentMethod: PaymentMethod.REWARD,
      status: TransactionStatus.COMPLETED,
      videoId,
      description: `Earned €${earnedAmount.toFixed(4)} from watching video`,
      metadata: {
        watchDuration,
        videoDuration: video.duration,
        watchPercentage,
        rewardAmount: earnedAmount,
      },
    });

    return {
      earned: true,
      amount: earnedAmount,
      message: `You earned €${earnedAmount.toFixed(4)} for watching this video!`,
    };
  }

  /**
   * Disable boost and rewards when pool is depleted
   * Sets video back to normal (non-boosted) state
   */
  private async disableBoostAndRewards(
    videoId: string,
    videoRewardId: Types.ObjectId,
  ): Promise<void> {
    // Deactivate video reward
    await this.videoRewardModel.findByIdAndUpdate(videoRewardId, {
      isActive: false,
    });

    // Update video: remove boost status and priority
    await this.videoModel.findByIdAndUpdate(videoId, {
      isBoosted: false,
      boostScore: 0,
      hasRewardPool: false,
    });
  }

 private async updateUserRewardBalance(
  userId: string,
  amount: number,
): Promise<UserRewardBalance> {
  let balance = await this.userRewardBalanceModel
    .findOne({ user: new Types.ObjectId(userId) })
    .exec();

  if (!balance) {
    balance = new this.userRewardBalanceModel({
      user: new Types.ObjectId(userId),
      availableBalance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      pendingWithdrawal: 0,
    });
  }

  balance.availableBalance += amount;
  balance.totalEarned += amount;

  return balance.save();
}


  private async updateGlobalStats(
    poolAdded: number,
    distributed: number,
  ): Promise<void> {
    let stats = await this.rewardPoolStatsModel.findOne().exec();

    if (!stats) {
      stats = new this.rewardPoolStatsModel({
        totalPoolAllocated: 0,
        totalDistributed: 0,
        totalPendingRewards: 0,
        totalUsers: 0,
        totalEarnings: 0,
      });
    }

    if (poolAdded > 0) {
      stats.totalPoolAllocated += poolAdded;
      stats.totalPendingRewards += poolAdded;
    }

    if (distributed > 0) {
      stats.totalDistributed += distributed;
      stats.totalPendingRewards -= distributed;
      stats.totalEarnings += distributed;
    }

    await stats.save();
  }

  async getUserRewardBalance(userId: string): Promise<UserRewardBalance> {
    let balance = await this.userRewardBalanceModel
      .findOne({ user: new Types.ObjectId(userId) })
      .exec();

    if (!balance) {
      balance = new this.userRewardBalanceModel({
        user: new Types.ObjectId(userId),
        availableBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        pendingWithdrawal: 0,
      });
      await balance.save();
    }

    return balance;
  }

  async getUserEarnings(userId: string, limit: number = 50): Promise<UserEarning[]> {
    return this.userEarningModel
      .find({ user: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('video', 'title thumbnailUrl')
      .exec();
  }

  async getVideoRewardPool(videoId: string) {
    const videoReward = await this.videoRewardModel
      .findOne({ video: new Types.ObjectId(videoId), isActive: true })
      .exec();

    if (!videoReward) {
      return {
        hasRewardPool: false,
        message: 'This video does not have an active reward pool',
        remainingBalance: 0,
        totalPool: 0,
        distributedAmount: 0,
        percentageRemaining: 0,
      };
    }

    const percentageRemaining = (videoReward.remainingRewards / videoReward.totalRewardPool) * 100;

    return {
      hasRewardPool: true,
      remainingBalance: videoReward.remainingRewards,
      totalPool: videoReward.totalRewardPool,
      distributedAmount: videoReward.distributedRewards,
      percentageRemaining: Math.round(percentageRemaining * 100) / 100, // Round to 2 decimals
      rewardPerView: videoReward.rewardPerView,
      eligibleViews: videoReward.eligibleViews,
      maxPossibleViews: Math.floor(videoReward.remainingRewards / videoReward.rewardPerView),
      isActive: videoReward.isActive,
    };
  }

  async getGlobalRewardStats(): Promise<RewardPoolStats> {
    let stats = await this.rewardPoolStatsModel.findOne().exec();

    if (!stats) {
      stats = new this.rewardPoolStatsModel({
        totalPoolAllocated: 0,
        totalDistributed: 0,
        totalPendingRewards: 0,
        totalUsers: 0,
        totalEarnings: 0,
      });
      await stats.save();
    }

    return stats;
  }

  // Admin: Get all user balances
  async getAllUserBalances(limit: number = 100): Promise<UserRewardBalance[]> {
    return this.userRewardBalanceModel
      .find()
      .sort({ availableBalance: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .exec();
  }

  // Admin: Get top earners
  async getTopEarners(limit: number = 20): Promise<UserRewardBalance[]> {
    return this.userRewardBalanceModel
      .find()
      .sort({ totalEarned: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .exec();
  }
}
