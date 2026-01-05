import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { StripeConnectService } from './stripe-connect.service';

/**
 * TEST MODE ONLY ENDPOINTS
 * These endpoints are for testing Stripe Connect functionality without authentication
 * DO NOT use in production - remove or protect these endpoints before going live
 */
@Controller('stripe-connect/test')
@Public()
export class StripeConnectTestController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  /**
   * TEST MODE ONLY: Add funds to platform account for testing payouts
   * Uses special Stripe test token to add funds to available balance
   */
  @Post('add-platform-funds')
  @HttpCode(HttpStatus.OK)
  async addTestPlatformFunds(@Body() body: { amount: number }) {
    if (!body.amount || body.amount <= 0) {
      return {
        success: false,
        message: 'Amount must be greater than 0',
      };
    }

    return this.stripeConnectService.addTestPlatformFunds(body.amount);
  }

  /**
   * TEST MODE ONLY: Get platform account balance
   */
  @Get('platform-balance')
  async getPlatformBalance() {
    return this.stripeConnectService.getAccountBalance();
  }
}
