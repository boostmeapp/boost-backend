import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BoostService } from './boost.service';
import { PromoteDto } from './dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { Query } from '@nestjs/common';

@Controller('boost')
@UseGuards(JwtAuthGuard)
export class BoostController {
  constructor(private readonly boostService: BoostService) {}

  /**
   * Quote the cost (in coins) for a budget/day × duration promotion — no charge.
   */
  @Get('quote')
  quote(
    @Query('budgetPerDay') budgetPerDay: string,
    @Query('durationDays') durationDays: string,
  ) {
    return this.boostService.quotePromotion(
      Number(budgetPerDay),
      Number(durationDays),
    );
  }

  /**
   * Promote a video: budget/day × duration paid from the user's COIN balance.
   * Returns 400 INSUFFICIENT_COINS if the user needs to top up first.
   */
  @Post('promote')
  @HttpCode(HttpStatus.OK)
  async promote(@CurrentUser() user: User, @Body() dto: PromoteDto) {
    return this.boostService.promoteVideo(user.id, dto);
  }

  /** Current user's boosts (restore purchases / history). */
  @Get('my-purchases')
  getMyPurchases(@CurrentUser() user: User) {
    return this.boostService.getMyPurchases(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelBoost(@CurrentUser() user: User, @Param('id') id: string) {
    return this.boostService.cancelBoost(user.id, id);
  }

  // ── Admin: Boost product catalog ──────────────────────────────────
  @Get('admin/products')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminListProducts() {
    return this.boostService.adminListProducts();
  }

  @Post('admin/products')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminCreateProduct(@Body() body: any) {
    return this.boostService.adminCreateProduct(body);
  }

  @Patch('admin/products/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminUpdateProduct(@Param('id') id: string, @Body() body: any) {
    return this.boostService.adminUpdateProduct(id, body);
  }

  @Delete('admin/products/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminDeleteProduct(@Param('id') id: string) {
    return this.boostService.adminDeleteProduct(id);
  }
}
