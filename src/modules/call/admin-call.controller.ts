import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { CallService } from './call.service';
import { CallMetricsService } from './call-metrics.service';
import {
  AdminCallQueryDto,
  CallMetricsQueryDto,
  SetCallingRestrictedDto,
} from './dto/admin-call-query.dto';

/**
 * Calling moderation and observability. Lives in the call module (not
 * AdminModule) so admin doesn't need to import calling's dependencies; the
 * guards and role are the same as every other /admin route.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminCallController {
  constructor(
    private readonly callService: CallService,
    private readonly metrics: CallMetricsService,
  ) {}

  @Get('calls')
  list(@Query() query: AdminCallQueryDto) {
    return this.callService.adminList(query);
  }

  // Declared before calls/:id so "metrics" is never read as an id.
  @Get('calls/metrics')
  getMetrics(@Query() query: CallMetricsQueryDto) {
    return this.metrics.compute(query.hours);
  }

  /** One call in full — for reviewing a call report (contentId is the call id). */
  @Get('calls/:id')
  get(@Param('id') id: string) {
    return this.callService.adminGet(id);
  }

  /** Force-end a live call; both clients drop within seconds. Idempotent. */
  @Post('calls/:id/terminate')
  @HttpCode(HttpStatus.OK)
  terminate(@CurrentUser() admin: User, @Param('id') id: string) {
    return this.callService.adminTerminate(id, admin._id.toString());
  }

  /** Stop a user placing calls without banning them from the app. */
  @Patch('users/:id/calling-restricted')
  setCallingRestricted(@Param('id') id: string, @Body() dto: SetCallingRestrictedDto) {
    return this.callService.setCallingRestricted(id, dto.restricted);
  }
}
