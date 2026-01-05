import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../database/schemas/user/user.schema';
import { WalletService } from '../wallet/wallet.service';
import { TransactionService } from '../transaction/transaction.service';
import { BoostService } from '../boost/boost.service';
import { RewardService } from '../reward/reward.service';
import { TransactionStatus } from '../../database/schemas/transaction/transaction.schema';
import { BoostStatus } from '../../database/schemas/boost/boost.schema';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    private walletService: WalletService,
    private transactionService: TransactionService,
    private boostService: BoostService,
    private rewardService: RewardService,
  ) {}

  async getAllUsers(): Promise<User[]> {
    return this.userModel.find().exec();
  }

  async deleteUser(userId: string): Promise<{ message: string }> {
    const user = await this.userModel.findById(userId).exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    await this.userModel.findByIdAndDelete(userId).exec();

    return {
      message: `User ${user.email} has been permanently deleted`,
    };
  }

  async toggleBanUser(userId: string): Promise<User> {
    const user = await this.userModel.findById(userId).exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const newBanStatus = !user.isBanned;

    const updatedUser = await this.userModel
      .findByIdAndUpdate(
        userId,
        {
          isBanned: newBanStatus,
          bannedAt: newBanStatus ? new Date() : null,
          isActive: !newBanStatus,
        },
        { new: true },
      )
      .exec();

    if (!updatedUser) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return updatedUser;
  }

  // Transaction management
  async getAllTransactions(limit: number) {
    return this.transactionService.getAllTransactions(limit);
  }

  async getTransactionsByStatus(status: TransactionStatus, limit: number) {
    return this.transactionService.getTransactionsByStatus(status, limit);
  }

  // Wallet management
  async getAllWallets() {
    return this.walletService.getAllWallets();
  }

  async lockWallet(userId: string, reason: string) {
    return this.walletService.lockWallet(userId, reason);
  }

  async unlockWallet(userId: string) {
    return this.walletService.unlockWallet(userId);
  }

  // Boost management
  async getAllBoosts(limit: number) {
    return this.boostService.getAllBoosts(limit);
  }

  async getBoostsByStatus(status: BoostStatus, limit: number) {
    return this.boostService.getBoostsByStatus(status, limit);
  }

  // Reward management
  async getAllUserBalances(limit: number) {
    return this.rewardService.getAllUserBalances(limit);
  }

  async getTopEarners(limit: number) {
    return this.rewardService.getTopEarners(limit);
  }

  async getGlobalRewardStats() {
    return this.rewardService.getGlobalRewardStats();
  }
}
