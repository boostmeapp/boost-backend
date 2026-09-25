import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CallHistoryQueryDto } from './dto/call-history-query.dto';
import { CallStatsDto } from './dto/call-stats.dto';
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

  @Get()
  history(@CurrentUser() user: User, @Query() query: CallHistoryQueryDto) {
    return this.callService.getHistory(user, query);
  }

  // A coarse burst cap; the real per-caller limit is Iteration 11.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  initiate(@CurrentUser() user: User, @Body() dto: InitiateCallDto) {
    return this.callService.initiate(user, dto);
  }

  // Lifecycle reports. The client acts through the Stream SDK first (that is
  // what makes it instant), then tells us. All idempotent.

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: User, @Param('id') id: string) {
    return this.callService.performAction(user, id, 'accept');
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@CurrentUser() user: User, @Param('id') id: string) {
    return this.callService.performAction(user, id, 'reject');
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return this.callService.performAction(user, id, 'cancel');
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  end(@CurrentUser() user: User, @Param('id') id: string) {
    return this.callService.performAction(user, id, 'end');
  }

  /** Client-reported call quality at end. Participants only; bounded input. */
  @Post(':id/stats')
  @HttpCode(HttpStatus.OK)
  stats(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: CallStatsDto) {
    return this.callService.recordStats(user, id, dto);
  }
}
