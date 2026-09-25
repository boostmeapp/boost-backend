import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { CallService } from './call.service';

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallController {
  constructor(private readonly callService: CallService) {}

  // Clients refetch only on expiry (24h) or reconnect, so this is capped well
  // below the global limit.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@CurrentUser() user: User) {
    return this.callService.issueToken(user);
  }
}
