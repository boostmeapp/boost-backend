import {
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User } from '../../database/schemas/user/user.schema';
import { CoinPackage } from '../../database/schemas/coin/coin-package.schema';
import {
  CoinTransaction,
  CoinTxnType,
} from '../../database/schemas/coin/coin-transaction.schema';
import { IapValidationService } from '../boost/iap-validation.service';

// Default coin packs seeded on first boot (prices are set in the stores).
const DEFAULT_COIN_PACKAGES = [
  { key: '70_coins', title: '70 Coins', coins: 70, bonusCoins: 0, iosProductId: '70_coins', androidProductId: '70_coins', priceLabel: '$0.99', sortOrder: 1 },
  { key: '350_coins', title: '350 Coins', coins: 350, bonusCoins: 0, iosProductId: '350_coins', androidProductId: '350_coins', priceLabel: '$4.99', sortOrder: 2 },
  { key: '700_coins', title: '700 Coins', coins: 700, bonusCoins: 35, iosProductId: '700_coins', androidProductId: '700_coins', priceLabel: '$9.99', sortOrder: 3 },
  { key: '1400_coins', title: '1400 Coins', coins: 1400, bonusCoins: 100, iosProductId: '1400_coins', androidProductId: '1400_coins', priceLabel: '$19.99', sortOrder: 4 },
  { key: '3500_coins', title: '3500 Coins', coins: 3500, bonusCoins: 350, iosProductId: '3500_coins', androidProductId: '3500_coins', priceLabel: '$49.99', sortOrder: 5 },
  { key: '7000_coins', title: '7000 Coins', coins: 7000, bonusCoins: 1000, iosProductId: '7000_coins', androidProductId: '7000_coins', priceLabel: '$99.99', sortOrder: 6 },
];

@Injectable()
export class CoinsService implements OnModuleInit {
  private readonly logger = new Logger(CoinsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(CoinPackage.name) private packageModel: Model<CoinPackage>,
    @InjectModel(CoinTransaction.name)
    private txnModel: Model<CoinTransaction>,
    private iapValidationService: IapValidationService,
  ) {}

  async onModuleInit() {
    const count = await this.packageModel.estimatedDocumentCount();
    if (count === 0) {
      await this.packageModel.insertMany(
        DEFAULT_COIN_PACKAGES.map((p) => ({ ...p, isActive: true })),
      );
      this.logger.log('Seeded default coin packages');
    }
  }

  async getActivePackages(): Promise<CoinPackage[]> {
    return (await this.packageModel
      .find({ isActive: true })
      .sort({ sortOrder: 1 })
      .lean()) as unknown as CoinPackage[];
  }

  async getBalance(userId: string): Promise<{ coinBalance: number }> {
    const user = await this.userModel.findById(userId).select('coinBalance').lean();
    return { coinBalance: user?.coinBalance || 0 };
  }

  async getHistory(userId: string, limit = 50): Promise<CoinTransaction[]> {
    return (await this.txnModel
      .find({ user: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()) as unknown as CoinTransaction[];
  }

  /**
   * Verify an IAP coin purchase and credit coins (idempotent).
   */
  async purchaseCoins(
    userId: string,
    dto: { packageKey: string; platform: 'ios' | 'android'; receipt: string },
  ) {
    const pack = await this.packageModel.findOne({
      key: dto.packageKey,
      isActive: true,
    });
    if (!pack) throw new NotFoundException('Coin package not found');

    const storeProductId =
      dto.platform === 'ios' ? pack.iosProductId : pack.androidProductId;
    const verification = await this.iapValidationService.validate(
      dto.platform,
      dto.receipt,
      storeProductId,
    );

    // Idempotency — same store txn can't credit twice
    const existing = await this.txnModel.findOne({
      storeTransactionId: verification.transactionId,
    });
    if (existing) {
      const bal = await this.getBalance(userId);
      return { alreadyProcessed: true, ...bal };
    }

    const credited = pack.coins + (pack.bonusCoins || 0);
    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { $inc: { coinBalance: credited } },
      { new: true },
    );
    if (!user) throw new NotFoundException('User not found');

    await this.txnModel.create({
      user: new Types.ObjectId(userId),
      type: CoinTxnType.PURCHASE,
      coins: credited,
      balanceAfter: user.coinBalance,
      platform: dto.platform,
      storeTransactionId: verification.transactionId,
      description: `Purchased ${pack.title}`,
      ref: pack.key,
    });

    return { success: true, credited, coinBalance: user.coinBalance };
  }

  /**
   * Credit coins from a RevenueCat webhook event (idempotent by event id).
   * Called for NON_RENEWING_PURCHASE (consumable coin packs).
   */
  async creditFromRevenueCat(args: {
    appUserId: string;
    productId: string;
    eventId: string;
    platform?: string;
  }) {
    if (!args.appUserId || !args.productId || !args.eventId) {
      return { ignored: true, reason: 'missing fields' };
    }
    if (!Types.ObjectId.isValid(args.appUserId)) {
      // app_user_id isn't our user id (e.g. anonymous) — ignore safely
      return { ignored: true, reason: 'app_user_id not a user id' };
    }

    const pack = await this.packageModel.findOne({
      $or: [
        { iosProductId: args.productId },
        { androidProductId: args.productId },
      ],
    });
    if (!pack) return { ignored: true, reason: 'unknown product' };

    // Idempotency — the RevenueCat event id is stored as the store txn id
    const existing = await this.txnModel.findOne({
      storeTransactionId: args.eventId,
    });
    if (existing) return { alreadyProcessed: true };

    const credited = pack.coins + (pack.bonusCoins || 0);
    const user = await this.userModel.findByIdAndUpdate(
      args.appUserId,
      { $inc: { coinBalance: credited } },
      { new: true },
    );
    if (!user) return { ignored: true, reason: 'user not found' };

    await this.txnModel.create({
      user: new Types.ObjectId(args.appUserId),
      type: CoinTxnType.PURCHASE,
      coins: credited,
      balanceAfter: user.coinBalance,
      platform: args.platform,
      storeTransactionId: args.eventId,
      description: `Purchased ${pack.title} (RevenueCat)`,
      ref: pack.key,
    });

    this.logger.log(`Credited ${credited} coins to ${args.appUserId} (RevenueCat)`);
    return { success: true, credited, coinBalance: user.coinBalance };
  }

  /**
   * Spend coins (used when promoting a video). Throws if insufficient.
   */
  async spendCoins(
    userId: string,
    coins: number,
    description: string,
    ref?: string,
  ): Promise<{ coinBalance: number }> {
    if (coins <= 0) throw new BadRequestException('Invalid coin amount');

    // Atomic conditional decrement — only succeeds when balance is enough
    const user = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), coinBalance: { $gte: coins } },
      { $inc: { coinBalance: -coins } },
      { new: true },
    );
    if (!user) {
      throw new BadRequestException('INSUFFICIENT_COINS');
    }

    await this.txnModel.create({
      user: new Types.ObjectId(userId),
      type: CoinTxnType.SPEND,
      coins: -coins,
      balanceAfter: user.coinBalance,
      description,
      ref,
    });

    return { coinBalance: user.coinBalance };
  }

  /**
   * Refund unused coins to user's balance when a promotion is cancelled early.
   */
  async refundCoins(
    userId: string,
    coins: number,
    description: string,
    ref?: string,
  ): Promise<{ coinBalance: number }> {
    if (coins <= 0) {
      const bal = await this.getBalance(userId);
      return { coinBalance: bal.coinBalance };
    }

    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { $inc: { coinBalance: coins } },
      { new: true },
    );
    if (!user) throw new NotFoundException('User not found');

    await this.txnModel.create({
      user: new Types.ObjectId(userId),
      type: CoinTxnType.REFUND,
      coins: coins,
      balanceAfter: user.coinBalance,
      description,
      ref,
    });

    this.logger.log(`Refunded ${coins} coins to user ${userId}`);
    return { coinBalance: user.coinBalance };
  }

  // ── Admin ──
  async adminListPackages() {
    return this.packageModel.find().sort({ sortOrder: 1 }).lean();
  }
  async adminCreatePackage(data: Partial<CoinPackage>) {
    return this.packageModel.create(data);
  }
  async adminUpdatePackage(id: string, data: Partial<CoinPackage>) {
    const updated = await this.packageModel.findByIdAndUpdate(id, data, { new: true });
    if (!updated) throw new NotFoundException('Coin package not found');
    return updated;
  }
  async adminDeletePackage(id: string) {
    const res = await this.packageModel.findByIdAndDelete(id);
    if (!res) throw new NotFoundException('Coin package not found');
    return { success: true };
  }
}
