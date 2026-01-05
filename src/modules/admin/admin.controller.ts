import {
  Controller,
  Delete,
  Param,
  Patch,
  Get,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { UserRole } from '../../database/schemas/user/user.schema';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  getAllUsers() {
    return this.adminService.getAllUsers();
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.OK)
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  @Patch('users/:id/ban')
  toggleBanUser(@Param('id') id: string) {
    return this.adminService.toggleBanUser(id);
  }

  // Transaction management
  @Get('transactions')
  getAllTransactions(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getAllTransactions(limitNum);
  }

  @Get('transactions/status/:status')
  getTransactionsByStatus(
    @Param('status') status: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getTransactionsByStatus(status as any, limitNum);
  }

  // Wallet management
  @Get('wallets')
  getAllWallets() {
    return this.adminService.getAllWallets();
  }

  @Patch('wallets/:userId/lock')
  lockWallet(@Param('userId') userId: string, @Query('reason') reason: string) {
    return this.adminService.lockWallet(userId, reason || 'Admin action');
  }

  @Patch('wallets/:userId/unlock')
  unlockWallet(@Param('userId') userId: string) {
    return this.adminService.unlockWallet(userId);
  }

  // Boost management
  @Get('boosts')
  getAllBoosts(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getAllBoosts(limitNum);
  }

  @Get('boosts/status/:status')
  getBoostsByStatus(
    @Param('status') status: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getBoostsByStatus(status as any, limitNum);
  }

  // Reward management
  @Get('rewards/balances')
  getAllUserBalances(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getAllUserBalances(limitNum);
  }

  @Get('rewards/top-earners')
  getTopEarners(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.adminService.getTopEarners(limitNum);
  }

  @Get('rewards/stats')
  getGlobalRewardStats() {
    return this.adminService.getGlobalRewardStats();
  }
}
