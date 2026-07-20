import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { CoinsService } from './coins.service';
import { PurchaseCoinsDto } from './dto/purchase-coins.dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles, Public } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { ENV } from '../../config';

@Controller('coins')
@UseGuards(JwtAuthGuard)
export class CoinsController {
  constructor(private readonly coinsService: CoinsService) {}

  /**
   * RevenueCat webhook — credits coins after a verified store purchase.
   * Public route; authenticated by the Authorization header secret.
   */
  @Public()
  @Post('webhook/revenuecat')
  @HttpCode(HttpStatus.OK)
  async revenueCatWebhook(
    @Headers('authorization') auth: string,
    @Body() body: any,
  ) {
    const secret = ENV.REVENUECAT_WEBHOOK_SECRET;
    if (secret && auth !== secret) {
      throw new UnauthorizedException('Invalid webhook authorization');
    }
    const ev = body?.event || {};
    if (ev.type !== 'NON_RENEWING_PURCHASE' && ev.type !== 'INITIAL_PURCHASE') {
      return { ignored: true, type: ev.type };
    }
    return this.coinsService.creditFromRevenueCat({
      appUserId: ev.app_user_id,
      productId: ev.product_id,
      eventId: ev.id,
      platform: ev.store,
    });
  }

  /** Coin packs for the top-up sheet. */
  @Get('packages')
  getPackages() {
    return this.coinsService.getActivePackages();
  }

  /** Current coin balance. */
  @Get('balance')
  getBalance(@CurrentUser() user: User) {
    return this.coinsService.getBalance(user.id);
  }

  /** Coin purchase / spend history. */
  @Get('history')
  getHistory(@CurrentUser() user: User) {
    return this.coinsService.getHistory(user.id);
  }

  /** Verify an IAP coin purchase and credit coins. */
  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  purchase(@CurrentUser() user: User, @Body() dto: PurchaseCoinsDto) {
    return this.coinsService.purchaseCoins(user.id, dto);
  }

  // ── Admin: coin package catalog ──
  @Get('admin/packages')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminList() {
    return this.coinsService.adminListPackages();
  }

  @Post('admin/packages')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminCreate(@Body() body: any) {
    return this.coinsService.adminCreatePackage(body);
  }

  @Patch('admin/packages/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminUpdate(@Param('id') id: string, @Body() body: any) {
    return this.coinsService.adminUpdatePackage(id, body);
  }

  @Delete('admin/packages/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adminDelete(@Param('id') id: string) {
    return this.coinsService.adminDeletePackage(id);
  }
}
