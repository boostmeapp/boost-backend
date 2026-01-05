import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Boost,
  BoostPackage,
  BoostStatus,
  BOOST_PACKAGES,
  REWARD_CONFIG,
} from '../../database/schemas/boost/boost.schema';
import { Video } from '../../database/schemas/video/video.schema';
import { WalletService } from '../wallet/wallet.service';
import { TransactionService } from '../transaction/transaction.service';
import { RewardService } from '../reward/reward.service';
import {
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from '../../database/schemas/transaction/transaction.schema';

@Injectable()
export class BoostService {
  constructor(
    @InjectModel(Boost.name) private boostModel: Model<Boost>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    private walletService: WalletService,
    private transactionService: TransactionService,
    @Inject(forwardRef(() => RewardService))
    private rewardService: RewardService,
  ) {}

  /**
   * Create a boost for a video (payment handled separately via Stripe)
   * This is called AFTER successful Stripe payment
   */
  async createBoost(
    userId: string,
    videoId: string,
    amount: number,
    stripePaymentIntentId?: string,
  ): Promise<Boost> {
    // Validate video exists and belongs to user
    const video = await this.videoModel.findById(videoId).exec();
    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.user.toString() !== userId) {
      throw new BadRequestException('You can only boost your own videos');
    }

    // Check if video is already boosted
    const existingBoost = await this.boostModel
      .findOne({
        video: videoId,
        status: { $in: [BoostStatus.ACTIVE, BoostStatus.PENDING] },
      })
      .exec();

    if (existingBoost) {
      throw new BadRequestException('Video already has an active boost');
    }

    // Validate amount (€1 - €100)
    if (amount < REWARD_CONFIG.MIN_BOOST_AMOUNT || amount > REWARD_CONFIG.MAX_BOOST_AMOUNT) {
      throw new BadRequestException(
        `Boost amount must be between €${REWARD_CONFIG.MIN_BOOST_AMOUNT} and €${REWARD_CONFIG.MAX_BOOST_AMOUNT}`,
      );
    }

    // Calculate reward pool and max views (no end date - runs until pool is depleted)
    const startDate = new Date();
    const rewardPool = amount * REWARD_CONFIG.REWARD_POOL_PERCENTAGE;
    const maxRewardedViews = Math.floor(rewardPool / REWARD_CONFIG.FIXED_REWARD_PER_VIEW);

    // Create boost (no end date - boost stays active until reward pool depleted)
    const boost = new this.boostModel({
      user: new Types.ObjectId(userId),
      video: new Types.ObjectId(videoId),
      package: BoostPackage.CUSTOM,
      amount,
      targetViews: maxRewardedViews,
      currentViews: 0,
      duration: 0, // No fixed duration
      startDate,
      endDate: undefined, // No end date
      status: BoostStatus.ACTIVE,
    });

    const savedBoost = await boost.save();

    // Create transaction record for boost purchase
    const transaction = await this.transactionService.create({
      userId,
      type: TransactionType.BOOST_PURCHASE,
      amount,
      balanceBefore: 0, // No wallet balance involved
      balanceAfter: 0,
      paymentMethod: PaymentMethod.STRIPE,
      status: TransactionStatus.COMPLETED,
      videoId,
      boostId: savedBoost.id,
      stripePaymentIntentId,
      description: `Boosted video with €${amount} (direct payment)`,
      metadata: {
        amount,
        rewardPool,
        maxRewardedViews,
        platformRevenue: amount * REWARD_CONFIG.PLATFORM_REVENUE_PERCENTAGE,
      },
    });

    // Update boost with transaction reference
    savedBoost.transaction = transaction.id as any;
    await savedBoost.save();

    // Update video boost fields and reward pool (no end date)
    await this.videoModel.findByIdAndUpdate(videoId, {
      isBoosted: true,
      boostStartDate: startDate,
      boostEndDate: undefined, // No end date - runs until pool depleted
      boostScore: this.calculateBoostScore(amount),
      hasRewardPool: true,
      rewardPoolAmount: rewardPool,
      rewardPoolDistributed: 0,
      rewardEligibleViews: 0,
    });

    // Create video reward record
    await this.rewardService.createVideoReward(savedBoost.id, videoId);

    return savedBoost;
  }

  /**
   * Calculate boost score based on amount paid
   * Higher amounts get higher priority in feed
   */
  private calculateBoostScore(amount: number): number {
    // Score scales with amount: €1 = 10 points, €100 = 1000 points
    return amount * 10;
  }

  async getUserBoosts(userId: string): Promise<Boost[]> {
    return this.boostModel
      .find({ user: userId })
      .sort({ createdAt: -1 })
      .populate('video', 'title thumbnailUrl viewCount')
      .exec();
  }

  async getVideoBoosts(videoId: string): Promise<Boost[]> {
    return this.boostModel
      .find({ video: videoId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async cancelBoost(userId: string, boostId: string): Promise<Boost> {
    const boost = await this.boostModel.findById(boostId).exec();

    if (!boost) {
      throw new NotFoundException('Boost not found');
    }

    if (boost.user.toString() !== userId) {
      throw new BadRequestException('You can only cancel your own boosts');
    }

    if (boost.status !== BoostStatus.ACTIVE) {
      throw new BadRequestException('Only active boosts can be cancelled');
    }

    boost.status = BoostStatus.CANCELLED;
    const savedBoost = await boost.save();

    // Update video
    await this.videoModel.findByIdAndUpdate(boost.video, {
      isBoosted: false,
      boostScore: 0,
    });

    return savedBoost;
  }

  // Note: Boosts now expire automatically when reward pool is depleted
  // This is handled in RewardService.recordVideoWatch() method
  // No need for a date-based expiry cron job

  // Admin: Get all boosts
  async getAllBoosts(limit: number = 100): Promise<Boost[]> {
    return this.boostModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .populate('video', 'title thumbnailUrl viewCount')
      .exec();
  }

  // Admin: Get boosts by status
  async getBoostsByStatus(status: BoostStatus, limit: number = 100): Promise<Boost[]> {
    return this.boostModel
      .find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'email firstName lastName')
      .populate('video', 'title thumbnailUrl viewCount')
      .exec();
  }
}
