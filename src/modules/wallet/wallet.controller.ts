import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { IsNumber, Min } from 'class-validator';

class AddEarningsDto {
  @IsNumber()
  @Min(0.01)
  amount: number;
}

@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /**
   * Get current user's wallet
   */
  @Get()
  async getWallet(@CurrentUser() user: User) {
    return this.walletService.getWallet(user.id);
  }

  /**
   * Get current user's balance
   */
  @Get('balance')
  async getBalance(@CurrentUser() user: User) {
    const balance = await this.walletService.getBalance(user.id);
    return { balance };
  }

  /**
   * Add earnings to user's wallet (for testing)
   * In production, this should be protected/removed
   */
  @Post('add-earnings')
  async addEarnings(
    @CurrentUser() user: User,
    @Body() dto: AddEarningsDto,
  ) {
    const wallet = await this.walletService.addEarnings(user.id, dto.amount);
    return {
      success: true,
      message: `Added £${dto.amount} to wallet`,
      balance: wallet.balance,
      totalEarned: wallet.totalEarned,
    };
  }

  /**
   * Test: Simulate watching a video and earning money
   * This is for testing the payout flow
   */
  @Post('test/watch-video')
  async simulateVideoWatch(@CurrentUser() user: User) {
    // Simulate earning £2 from watching a video (typical reward amount)
    const rewardAmount = 2.0;
    const wallet = await this.walletService.addEarnings(user.id, rewardAmount);

    return {
      success: true,
      message: `Watched video and earned £${rewardAmount}`,
      balance: wallet.balance,
      totalEarned: wallet.totalEarned,
      minimumPayoutAmount: 20,
      note: 'This is a test endpoint. In production, earnings are added when users watch videos. You need £20 minimum to trigger automatic payout.',
    };
  }

  /**
   * Admin: Get all wallets
   */
  @Get('admin/all')
  @Roles(UserRole.ADMIN)
  async getAllWallets() {
    return this.walletService.getAllWallets();
  }
}
