import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Patch,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CallHistoryQueryDto } from './dto/call-history-query.dto';
import { CallStatsDto } from './dto/call-stats.dto';
import { UpdateCallSettingsDto } from './dto/update-call-settings.dto';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { CallService } from './call.service';
import { InitiateCallDto } from './dto/initiate-call.dto';
import { IssueTokenDto } from './dto/issue-token.dto';
import { ClaimCallingDeviceDto } from './dto/claim-device.dto';

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

  /**
   * "This install is where I take calls" — sent by the app whenever the user
   * opens it. Only the claimed device rings and may call.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('device')
  @HttpCode(HttpStatus.OK)
  claimDevice(
    @CurrentUser() user: User,
    @Headers('x-device-id') deviceId: string | undefined,
    @Body() dto: ClaimCallingDeviceDto,
  ) {
    return this.callService.claimDevice(user, deviceId, dto);
  }

  @Get()
  history(@CurrentUser() user: User, @Query() query: CallHistoryQueryDto) {
    return this.callService.getHistory(user, query);
  }

  /** "Clear call history" — the requester's list only. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  clearHistory(@CurrentUser() user: User) {
    return this.callService.clearHistory(user);
  }

  @Get('settings')
  getSettings(@CurrentUser() user: User) {
    return this.callService.getSettings(user);
  }

  @Patch('settings')
  updateSettings(@CurrentUser() user: User, @Body() dto: UpdateCallSettingsDto) {
    return this.callService.updateSettings(user, dto.callPrivacy);
  }

  /** Missed-call badge. */
  @Get('unseen-count')
  unseenCount(@CurrentUser() user: User) {
    return this.callService.getUnseenCount(user);
  }

  @Post('seen')
  @HttpCode(HttpStatus.OK)
  markSeen(@CurrentUser() user: User) {
    return this.callService.markSeen(user);
  }

  /** Pre-flight for the call button. Called on chat/profile focus, so capped. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('can-call/:userId')
  canCall(@CurrentUser() user: User, @Param('userId') userId: string) {
    return this.callService.canCall(user, userId);
  }

  /** Remove one call from the requester's own history. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  hide(@CurrentUser() user: User, @Param('id') id: string) {
    return this.callService.hideCall(user, id);
  }

  // A coarse burst cap; the real per-caller limit is Iteration 11.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  initiate(
    @CurrentUser() user: User,
    @Body() dto: InitiateCallDto,
    @Headers('x-device-id') deviceId: string | undefined,
  ) {
    return this.callService.initiate(user, dto, deviceId);
  }

  // Lifecycle reports. The client acts through the Stream SDK first (that is
  // what makes it instant), then tells us. All idempotent.

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Headers('x-device-id') deviceId: string | undefined,
  ) {
    return this.callService.performAction(user, id, 'accept', deviceId);
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
