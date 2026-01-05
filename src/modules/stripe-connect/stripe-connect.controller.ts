import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StripeConnectService } from './stripe-connect.service';
import { CreateConnectAccountDto } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

@Controller('stripe-connect')
@UseGuards(JwtAuthGuard)
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

 
  @Post('create-account')
  @HttpCode(HttpStatus.CREATED)
  async createConnectAccount(@CurrentUser() user: User) {
    return this.stripeConnectService.createConnectAccount(user.id, user.email);
  }

  // Legacy endpoint
  @Post('account')
  @HttpCode(HttpStatus.CREATED)
  async createAccount(
    @CurrentUser() user: User,
    @Body() dto: CreateConnectAccountDto,
  ) {
    return this.stripeConnectService.createConnectAccount(user.id, dto.email || user.email);
  }


  @Get('onboarding-link')
  async getOnboardingLink(@CurrentUser() user: User) {
    return this.stripeConnectService.createOnboardingLink(user.id);
  }


  @Get('login-link')
  async getLoginLink(@CurrentUser() user: User) {
    const url = await this.stripeConnectService.createLoginLink(user.id);
    return { url };
  }

  // Legacy endpoints for backward compatibility
  @Post('onboarding-link')
  @HttpCode(HttpStatus.OK)
  async createOnboardingLink(@CurrentUser() user: User) {
    return this.stripeConnectService.createOnboardingLink(user.id);
  }

  @Post('dashboard-link')
  @HttpCode(HttpStatus.OK)
  async createDashboardLink(@CurrentUser() user: User) {
    const url = await this.stripeConnectService.createLoginLink(user.id);
    return { url };
  }


  @Get('account')
  async getAccount(@CurrentUser() user: User) {
    if (!user.stripeConnectAccountId) {
      return {
        hasAccount: false,
        accountId: null,
        onboardingComplete: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      };
    }

    const accountInfo = await this.stripeConnectService.getAccountInfo(
      user.stripeConnectAccountId,
    );

    return {
      hasAccount: true,
      ...accountInfo,
    };
  }

  // Legacy endpoint
  @Get('account/status')
  async getAccountStatus(@CurrentUser() user: User) {
    if (!user.stripeConnectAccountId) {
      return {
        hasAccount: false,
        onboardingComplete: false,
      };
    }

    const accountInfo = await this.stripeConnectService.getAccountInfo(
      user.stripeConnectAccountId,
    );

    return {
      hasAccount: true,
      ...accountInfo,
    };
  }

 
  @Get('balance')
  async getBalance(@CurrentUser() user: User) {
    if (!user.stripeConnectAccountId) {
      return {
        available: 0,
        pending: 0,
        currency: 'EUR',
        allBalances: [],
      };
    }

    return this.stripeConnectService.getAccountBalance(user.stripeConnectAccountId);
  }


  @Post('refresh-status')
  @HttpCode(HttpStatus.OK)
  async refreshStatus(@CurrentUser() user: User) {
    return this.stripeConnectService.updateOnboardingStatus(user.id);
  }
}
