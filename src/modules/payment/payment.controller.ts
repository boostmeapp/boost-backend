import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Headers,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { Request } from 'express';
import { IsNumber, IsString, Min, Max } from 'class-validator';

// DTOs for boost payments
import { Type } from 'class-transformer';

class CreateBoostPaymentDto {
  @IsString()
  videoId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  amount: number;
}

class ConfirmBoostPaymentDto {
  @IsString()
  paymentIntentId: string;
}

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('boost/create-intent')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async createBoostPaymentIntent(
    @CurrentUser() user: User,
    @Body() dto: CreateBoostPaymentDto,
  ) {
    return this.paymentService.createBoostPaymentIntent(
      user.id,
      dto.videoId,
      dto.amount,
    );
  }

  @Post('boost/confirm')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async confirmBoostPayment(
    @CurrentUser() user: User,
    @Body() dto: ConfirmBoostPaymentDto,
  ) {
    return this.paymentService.confirmBoostPayment(dto.paymentIntentId, user.id);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // Note: This endpoint requires raw body to verify Stripe signature
    // You'll need to configure NestJS to preserve raw body for this route
    // For now, this is a placeholder - proper webhook implementation
    // would require additional configuration
    return { received: true };
  }
}
