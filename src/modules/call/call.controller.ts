import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { CallService } from './call.service';
import { InitiateCallDto } from './dto/initiate-call.dto';
import { IssueTokenDto } from './dto/issue-token.dto';

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallController {
  constructor(private readonly callService: CallService) {}

  // Clients refetch only on expiry (24h) or reconnect, so this is capped well
  // below the global limit.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@CurrentUser() user: User, @Body() dto: IssueTokenDto) {
    return this.callService.issueToken(user, dto.apnsEnvironment);
  }

  // A coarse burst cap; the real per-caller limit is Iteration 11.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  initiate(@CurrentUser() user: User, @Body() dto: InitiateCallDto) {
    return this.callService.initiate(user, dto);
  }
}
