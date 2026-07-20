import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Boost,
  BoostPackage,
  BoostStatus,
  BoostSource,
  BoostPlatform,
  BOOST_PACKAGES,
  REWARD_CONFIG,
} from '../../database/schemas/boost/boost.schema';
import { BoostProduct } from '../../database/schemas/boost-product/boost-product.schema';
import { Video } from '../../database/schemas/video/video.schema';
import { WalletService } from '../wallet/wallet.service';
import { TransactionService } from '../transaction/transaction.service';
import { RewardService } from '../reward/reward.service';
import { IapValidationService } from './iap-validation.service';
import { CoinsService } from '../coins/coins.service';
import { ENV } from '../../config';
import {
  TransactionType,
  TransactionStatus,
  PaymentMethod,
} from '../../database/schemas/transaction/transaction.schema';

// Promote limits (per TikTok-style budget/duration UI)
const MIN_BUDGET_PER_DAY = 3; // £3/day
const MAX_BUDGET_PER_DAY = 1000; // £1000/day
const MIN_DURATION_DAYS = 1;
const MAX_DURATION_DAYS = 30;

// Default catalog seeded on first boot if none exists (edit in admin later).
// NOTE: real prices are set in App Store Connect / Play Console; priceLabel is display-only.
const DEFAULT_BOOST_PRODUCTS = [
  { key: 'boost_24h', title: '24 Hour Boost', durationHours: 24, boostScore: 100, rewardPoolAmount: 0, iosProductId: 'boost_24h', androidProductId: 'boost_24h', priceLabel: '$1.99', sortOrder: 1 },
  { key: 'boost_3d', title: '3 Day Boost', durationHours: 72, boostScore: 200, rewardPoolAmount: 0, iosProductId: 'boost_3d', androidProductId: 'boost_3d', priceLabel: '$4.99', sortOrder: 2 },
  { key: 'boost_7d', title: '7 Day Boost', durationHours: 168, boostScore: 350, rewardPoolAmount: 0, iosProductId: 'boost_7d', androidProductId: 'boost_7d', priceLabel: '$9.99', sortOrder: 3 },
  { key: 'boost_30d', title: '30 Day Boost', durationHours: 720, boostScore: 600, rewardPoolAmount: 0, iosProductId: 'boost_30d', androidProductId: 'boost_30d', priceLabel: '$29.99', sortOrder: 4 },
];

@Injectable()
export class BoostService implements OnModuleInit {
  private readonly logger = new Logger(BoostService.name);

  constructor(
    @InjectModel(Boost.name) private boostModel: Model<Boost>,
    @InjectModel(BoostProduct.name) private boostProductModel: Model<BoostProduct>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    private walletService: WalletService,
    private transactionService: TransactionService,
    @Inject(forwardRef(() => RewardService))
    private rewardService: RewardService,
    private iapValidationService: IapValidationService,
    private coinsService: CoinsService,
  ) {}

  async onModuleInit() {
    const count = await this.boostProductModel.estimatedDocumentCount();
    if (count === 0) {
      await this.boostProductModel.insertMany(
        DEFAULT_BOOST_PRODUCTS.map((p) => ({ ...p, isActive: true })),
      );
      this.logger.log('Seeded default Boost products');
    }
  }

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

  // ═══════════════════════════════════════════════════════════════════
  // IN-APP PURCHASE: one-time, fixed-duration VIDEO boost
  // ═══════════════════════════════════════════════════════════════════

  /** Active Boost packages for the app store front. */
  async getActiveProducts(): Promise<BoostProduct[]> {
    return this.boostProductModel
      .find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean();
  }

  /**
   * Verify a store purchase and activate a time-based boost on the video.
   */
  async purchaseBoost(
    userId: string,
    dto: {
      productKey: string;
      platform: 'ios' | 'android';
      videoId: string;
      receipt: string; // iOS receipt data OR Android purchase token
    },
  ): Promise<Boost> {
    const product = await this.boostProductModel.findOne({
      key: dto.productKey,
      isActive: true,
    });
    if (!product) throw new NotFoundException('Boost package not found');

    const video = await this.videoModel.findById(dto.videoId).exec();
    if (!video) throw new NotFoundException('Video not found');
    if (video.user.toString() !== userId) {
      throw new BadRequestException('You can only boost your own videos');
    }

    // 1) Verify the receipt with Apple/Google
    const storeProductId =
      dto.platform === 'ios' ? product.iosProductId : product.androidProductId;
    const verification = await this.iapValidationService.validate(
      dto.platform,
      dto.receipt,
      storeProductId,
    );

    // 2) Idempotency — same store transaction can't activate two boosts
    const existing = await this.boostModel.findOne({
      storeTransactionId: verification.transactionId,
    });
    if (existing) {
      return existing; // already processed
    }

    // 3) Activate a time-based boost
    const startDate = new Date();
    const endDate = new Date(
      startDate.getTime() + product.durationHours * 60 * 60 * 1000,
    );

    const boost = new this.boostModel({
      user: new Types.ObjectId(userId),
      video: new Types.ObjectId(dto.videoId),
      package: BoostPackage.IAP,
      amount: 0, // real price handled by the store
      targetViews: 0,
      currentViews: 0,
      duration: product.durationHours,
      startDate,
      endDate,
      status: BoostStatus.ACTIVE,
      source: BoostSource.IAP,
      platform:
        dto.platform === 'ios' ? BoostPlatform.IOS : BoostPlatform.ANDROID,
      productKey: product.key,
      storeTransactionId: verification.transactionId,
    });
    const savedBoost = await boost.save();

    // 4) Transaction record (audit/history)
    const transaction = await this.transactionService.create({
      userId,
      type: TransactionType.BOOST_PURCHASE,
      amount: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      paymentMethod: PaymentMethod.STRIPE,
      status: TransactionStatus.COMPLETED,
      videoId: dto.videoId,
      boostId: savedBoost.id,
      description: `Boosted video (${product.title}, ${dto.platform} IAP)`,
      metadata: {
        productKey: product.key,
        storeTransactionId: verification.transactionId,
        environment: verification.environment,
        durationHours: product.durationHours,
      },
    });
    savedBoost.transaction = transaction.id as any;
    await savedBoost.save();

    // 5) Flip the video to boosted with a real end date
    await this.videoModel.findByIdAndUpdate(dto.videoId, {
      isBoosted: true,
      boostStartDate: startDate,
      boostEndDate: endDate,
      boostScore: product.boostScore,
      hasRewardPool: product.rewardPoolAmount > 0,
      rewardPoolAmount: product.rewardPoolAmount,
      rewardPoolDistributed: 0,
      rewardEligibleViews: 0,
    });

    if (product.rewardPoolAmount > 0) {
      await this.rewardService.createVideoReward(savedBoost.id, dto.videoId);
    }

    return savedBoost;
  }

  /**
   * Quote a promotion cost (no charge). budget/day × days → coins.
   */
  quotePromotion(budgetPerDay: number, durationDays: number) {
    const totalGbp = Number((budgetPerDay * durationDays).toFixed(2));
    const coins = Math.round(totalGbp * ENV.COINS_PER_GBP);
    return { budgetPerDay, durationDays, totalGbp, coins };
  }

  /**
   * Promote a video: pay budget/day × days from the user's COIN balance and
   * activate a time-based boost. Throws INSUFFICIENT_COINS if not enough coins.
   */
  async promoteVideo(
    userId: string,
    dto: { videoId: string; budgetPerDay: number; durationDays: number },
  ): Promise<any> {
    const budgetPerDay = Number(dto.budgetPerDay);
    const durationDays = Math.floor(Number(dto.durationDays));

    if (
      !budgetPerDay ||
      budgetPerDay < MIN_BUDGET_PER_DAY ||
      budgetPerDay > MAX_BUDGET_PER_DAY
    ) {
      throw new BadRequestException(
        `Budget must be between £${MIN_BUDGET_PER_DAY} and £${MAX_BUDGET_PER_DAY} per day`,
      );
    }
    if (
      !durationDays ||
      durationDays < MIN_DURATION_DAYS ||
      durationDays > MAX_DURATION_DAYS
    ) {
      throw new BadRequestException(
        `Duration must be between ${MIN_DURATION_DAYS} and ${MAX_DURATION_DAYS} days`,
      );
    }

    const video = await this.videoModel.findById(dto.videoId).exec();
    if (!video) throw new NotFoundException('Video not found');
    if (video.user.toString() !== userId) {
      throw new BadRequestException('You can only promote your own videos');
    }

    const quote = this.quotePromotion(budgetPerDay, durationDays);

    // 1) Spend coins (atomic; throws INSUFFICIENT_COINS if short)
    const spendResult = await this.coinsService.spendCoins(
      userId,
      quote.coins,
      `Promote video (£${budgetPerDay}/day × ${durationDays}d)`,
      dto.videoId,
    );

    // 2) Activate the time-based boost
    const startDate = new Date();
    const endDate = new Date(
      startDate.getTime() + durationDays * 24 * 60 * 60 * 1000,
    );
    // Higher daily budget = stronger feed placement
    const boostScore = Math.min(1000, Math.round(budgetPerDay * durationDays));

    const boost = new this.boostModel({
      user: new Types.ObjectId(userId),
      video: new Types.ObjectId(dto.videoId),
      package: BoostPackage.IAP,
      amount: quote.totalGbp,
      targetViews: 0,
      currentViews: 0,
      duration: durationDays * 24,
      startDate,
      endDate,
      status: BoostStatus.ACTIVE,
      source: BoostSource.IAP,
      productKey: `promote_${budgetPerDay}x${durationDays}`,
    });
    const savedBoost = await boost.save();

    await this.transactionService.create({
      userId,
      type: TransactionType.BOOST_PURCHASE,
      amount: quote.totalGbp,
      balanceBefore: 0,
      balanceAfter: 0,
      paymentMethod: PaymentMethod.STRIPE,
      status: TransactionStatus.COMPLETED,
      videoId: dto.videoId,
      boostId: savedBoost.id,
      description: `Promoted video (£${budgetPerDay}/day × ${durationDays}d, ${quote.coins} coins)`,
      metadata: { ...quote },
    });

    await this.videoModel.findByIdAndUpdate(dto.videoId, {
      isBoosted: true,
      boostStartDate: startDate,
      boostEndDate: endDate,
      boostScore,
    });

    return {
      success: true,
      boost: savedBoost,
      coinsSpent: quote.coins,
      coinBalance: spendResult.coinBalance,
      endDate,
    };
  }

  /** User's boosts (for "restore purchases" / history). */
  async getMyPurchases(userId: string): Promise<Boost[]> {
    return this.boostModel
      .find({ user: new Types.ObjectId(userId), source: BoostSource.IAP })
      .sort({ createdAt: -1 })
      .populate('video', 'title thumbnailUrl')
      .lean();
  }

  /**
   * Expire time-based boosts whose end date has passed. Runs every 10 min.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireDueBoosts(): Promise<void> {
    const now = new Date();
    const due = await this.boostModel.find({
      status: BoostStatus.ACTIVE,
      endDate: { $ne: null, $lte: now },
    });
    if (!due.length) return;

    for (const boost of due) {
      boost.status = BoostStatus.EXPIRED;
      await boost.save();
      await this.videoModel.findByIdAndUpdate(boost.video, {
        isBoosted: false,
        boostScore: 0,
        hasRewardPool: false,
      });
    }
    this.logger.log(`Expired ${due.length} boost(s)`);
  }

  // ── Admin: Boost product catalog CRUD ──────────────────────────────
  async adminListProducts(): Promise<BoostProduct[]> {
    return this.boostProductModel.find().sort({ sortOrder: 1 }).lean();
  }

  async adminCreateProduct(data: Partial<BoostProduct>): Promise<BoostProduct> {
    return this.boostProductModel.create(data);
  }

  async adminUpdateProduct(
    id: string,
    data: Partial<BoostProduct>,
  ): Promise<BoostProduct> {
    const updated = await this.boostProductModel.findByIdAndUpdate(id, data, {
      new: true,
    });
    if (!updated) throw new NotFoundException('Boost product not found');
    return updated;
  }

  async adminDeleteProduct(id: string): Promise<{ success: boolean }> {
    const res = await this.boostProductModel.findByIdAndDelete(id);
    if (!res) throw new NotFoundException('Boost product not found');
    return { success: true };
  }
}
