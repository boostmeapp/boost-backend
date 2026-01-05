import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PayoutService } from './payout.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../database/schemas/user/user.schema';
import { PayoutFiltersDto } from './dto';

@Controller('payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayoutController {
  constructor(private readonly payoutService: PayoutService) {}

  /**
   * Get current user's payout history
   */
  @Get('my-payouts')
  async getMyPayouts(
    @CurrentUser() user: any,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.payoutService.getUserPayouts(
      user.userId,
      limit ? Number(limit) : 20,
      skip ? Number(skip) : 0,
    );
  }

  /**
   * Get specific payout details
   */
  @Get(':id')
  async getPayoutById(@Param('id') id: string) {
    return this.payoutService.getPayoutById(id);
  }

  /**
   * Get logs for a specific payout
   */
  @Get(':id/logs')
  async getPayoutLogs(@Param('id') id: string) {
    return this.payoutService.getPayoutLogs(id);
  }

  /**
   * Get batch payout information
   */
  @Get('batch/:batchId')
  async getBatchPayouts(@Param('batchId') batchId: string) {
    return this.payoutService.getBatchPayouts(batchId);
  }

  /**
   * Get batch statistics
   */
  @Get('batch/:batchId/stats')
  async getBatchStats(@Param('batchId') batchId: string) {
    return this.payoutService.getBatchStats(batchId);
  }

  /**
   * Admin: Manually trigger weekly payouts
   */
  @Post('admin/trigger-weekly')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async triggerWeeklyPayouts() {
    return this.payoutService.initiateScheduledPayouts();
  }

  /**
   * Admin: Manually retry failed payouts
   */
  @Post('admin/retry-failed')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async retryFailedPayouts() {
    const retriedCount = await this.payoutService.retryFailedPayouts();
    return {
      success: true,
      retriedCount,
      message: `Queued ${retriedCount} payouts for retry`,
    };
  }

  /**
   * Admin: Cancel a pending payout
   */
  @Post('admin/:id/cancel')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async cancelPayout(@Param('id') id: string) {
    const payout = await this.payoutService.cancelPayout(id);
    return {
      success: true,
      payout,
      message: 'Payout cancelled successfully',
    };
  }

  /**
   * Admin: Get all payouts with filters
   */
  @Get('admin/all')
  @Roles(UserRole.ADMIN)
  async getAllPayouts(
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.payoutService.getAllPayouts(
      status,
      limit ? Number(limit) : 100,
      skip ? Number(skip) : 0,
    );
  }

  /**
   * Admin: Get all payout logs (system-wide)
   */
  @Get('admin/logs/all')
  @Roles(UserRole.ADMIN)
  async getAllPayoutLogs(
    @Query('level') level?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: number,
  ) {
    return this.payoutService.getAllPayoutLogs(
      level,
      action,
      limit ? Number(limit) : 100,
    );
  }

  /**
   * Admin: Get payout statistics
   */
  @Get('admin/stats')
  @Roles(UserRole.ADMIN)
  async getPayoutStats() {
    return this.payoutService.getPayoutStats();
  }

  /**
   * Admin: Get user's payout history
   */
  @Get('admin/user/:userId')
  @Roles(UserRole.ADMIN)
  async getUserPayoutHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
  ) {
    return this.payoutService.getUserPayouts(
      userId,
      limit ? Number(limit) : 50,
      0,
    );
  }
}
