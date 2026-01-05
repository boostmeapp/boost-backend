import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { JwtAuthGuard } from '../../common/guards';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { TransactionType, TransactionStatus } from '../../database/schemas/transaction/transaction.schema';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  /**
   * Get current user's transactions
   */
  @Get()
  async getMyTransactions(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.transactionService.getUserTransactions(user.id, limitNum);
  }

  /**
   * Get current user's transactions by type
   */
  @Get('by-type')
  async getMyTransactionsByType(
    @CurrentUser() user: User,
    @Query('type') type: TransactionType,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.transactionService.getUserTransactionsByType(user.id, type, limitNum);
  }

  /**
   * Get current user's total spending
   */
  @Get('total-spending')
  async getTotalSpending(@CurrentUser() user: User) {
    const total = await this.transactionService.getUserTotalSpending(user.id);
    return { totalSpending: total };
  }

  /**
   * Get current user's total earnings
   */
  @Get('total-earnings')
  async getTotalEarnings(@CurrentUser() user: User) {
    const total = await this.transactionService.getUserTotalEarnings(user.id);
    return { totalEarnings: total };
  }

  /**
   * Admin: Get all transactions with filters
   */
  @Get('admin/all')
  @Roles(UserRole.ADMIN)
  async getAllTransactions(
    @Query('type') type?: TransactionType,
    @Query('status') status?: TransactionStatus,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    const skipNum = skip ? parseInt(skip, 10) : 0;
    return this.transactionService.getAllTransactionsAdmin(
      type,
      status,
      limitNum,
      skipNum,
    );
  }

  /**
   * Admin: Get user's transaction history
   */
  @Get('admin/user/:userId')
  @Roles(UserRole.ADMIN)
  async getUserTransactionsAdmin(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.transactionService.getUserTransactions(userId, limitNum);
  }

  /**
   * Admin: Get transaction statistics
   */
  @Get('admin/stats')
  @Roles(UserRole.ADMIN)
  async getTransactionStats() {
    return this.transactionService.getTransactionStats();
  }
}
