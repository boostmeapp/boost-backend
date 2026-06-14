import {
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  Body,
  Get,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles, CurrentUser } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { ResolveReportDto } from './dto/resolve-report.dto';

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

  // ── Dashboard ────────────────────────────────────────────────
  @Get('dashboard')
  getDashboard() {
    return this.adminService.getDashboardStats();
  }

  // ── Content moderation: reports ──────────────────────────────
  @Get('reports')
  getReports(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getReports(
      status,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('reports/stats')
  getReportStats() {
    return this.adminService.getReportStats();
  }

  @Post('reports/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveReport(
    @Param('id') id: string,
    @CurrentUser() admin: User,
    @Body() dto: ResolveReportDto,
  ) {
    return this.adminService.resolveReport(id, admin._id.toString(), dto);
  }

  // ── Content moderation: posts ────────────────────────────────
  @Get('videos')
  getVideos(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getAllVideosAdmin(
      status,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Patch('videos/:id/remove')
  removeVideo(
    @Param('id') id: string,
    @CurrentUser() admin: User,
    @Query('reason') reason?: string,
  ) {
    return this.adminService.removeVideo(id, admin._id.toString(), reason);
  }

  @Patch('videos/:id/restore')
  restoreVideo(@Param('id') id: string) {
    return this.adminService.restoreVideo(id);
  }

  // ── Content moderation: comments ─────────────────────────────
  @Patch('comments/:id/remove')
  removeComment(@Param('id') id: string) {
    return this.adminService.removeComment(id);
  }
}
