import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Wallet } from '../../database/schemas/wallet/wallet.schema';

@Injectable()
export class WalletService {
  constructor(
    @InjectModel(Wallet.name) private walletModel: Model<Wallet>,
  ) {}

  async createWallet(userId: string): Promise<Wallet> {
    // Use findOneAndUpdate with upsert to avoid race conditions
    const wallet = await this.walletModel.findOneAndUpdate(
      { user: new Types.ObjectId(userId) },
      {
        $setOnInsert: {
          user: new Types.ObjectId(userId),
          balance: 0,
          totalEarned: 0,
          totalWithdrawn: 0,
        },
      },
      {
        upsert: true,
        new: true,
      },
    ).exec();

    return wallet;
  }

  async getWallet(userId: string): Promise<Wallet> {
    const wallet = await this.walletModel.findOne({ user: userId }).exec();

    if (!wallet) {
      return await this.createWallet(userId);
    }

    return wallet;
  }

  /**
   * Add earnings from watching videos (withdrawable via Stripe Connect)
   */
  async addEarnings(userId: string, amount: number): Promise<Wallet> {
    if (amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    const wallet = await this.getWallet(userId);

    if (wallet.isLocked) {
      throw new BadRequestException(
        `Wallet is locked: ${wallet.lockedReason || 'Unknown reason'}`,
      );
    }

    wallet.balance += amount;
    wallet.totalEarned += amount;
    return wallet.save();
  }

  /**
   * Withdraw earnings to Stripe Connect
   */
  async withdrawEarnings(userId: string, amount: number): Promise<Wallet> {
    if (amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    const wallet = await this.getWallet(userId);

    if (wallet.isLocked) {
      throw new BadRequestException(
        `Wallet is locked: ${wallet.lockedReason || 'Unknown reason'}`,
      );
    }

    if (wallet.balance < amount) {
      throw new BadRequestException('Insufficient balance for withdrawal');
    }

    wallet.balance -= amount;
    wallet.totalWithdrawn += amount;
    return wallet.save();
  }

  async getBalance(userId: string): Promise<number> {
    const wallet = await this.getWallet(userId);
    return wallet.balance;
  }

  async lockWallet(userId: string, reason: string): Promise<Wallet> {
    const wallet = await this.getWallet(userId);

    wallet.isLocked = true;
    wallet.lockedReason = reason;
    wallet.lockedAt = new Date();

    return wallet.save();
  }

  async unlockWallet(userId: string): Promise<Wallet> {
    const wallet = await this.getWallet(userId);

    wallet.isLocked = false;
    wallet.lockedReason = undefined;
    wallet.lockedAt = undefined;

    return wallet.save();
  }

  // Admin: Get all wallets
  async getAllWallets(): Promise<Wallet[]> {
    return this.walletModel.find().populate('user', 'email firstName lastName').exec();
  }
}
