import {
  Body,
  Controller,
  Delete,
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

import { NotificationService } from './notification.service';
import { PushNotificationService } from './services/push-notification.service';
import { DevicePlatform } from './notification.constants';
import {
  ListNotificationsDto,
  RegisterDeviceTokenDto,
  RemoveDeviceTokenDto,
  SendTestNotificationDto,
} from './dto';

/**
 * Route order matters: Nest registers in declaration order, so every literal
 * path is declared before the `:id` wildcards. Otherwise `DELETE /devices`
 * would be swallowed by `DELETE /:id`.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly pushService: PushNotificationService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  In-app list                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The notifications screen. `filter` maps to its All / Unread / Boosts tabs.
   * Offset-paginated: `?offset=0&limit=10`, then `offset=pagination.nextOffset`.
   */
  @Get()
  async list(@CurrentUser() user: User, @Query() query: ListNotificationsDto) {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? ((query.page ?? 1) - 1) * limit;

    return this.notificationService.getUserNotifications(
      user.id,
      query.filter ?? 'all',
      offset,
      limit,
    );
  }

  /** Badge count for the bell. */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: User) {
    const count = await this.notificationService.getUnreadCount(user.id);
    return { count };
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@CurrentUser() user: User) {
    return this.notificationService.markAllAsRead(user.id);
  }

  @Delete('clear')
  @HttpCode(HttpStatus.OK)
  async clearAll(@CurrentUser() user: User) {
    return this.notificationService.clearAll(user.id);
  }

  /* ------------------------------------------------------------------ */
  /*  FCM tokens                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Called by the app after login and whenever FCM rotates the token.
   * Safe to call repeatedly — it upserts on the token.
   */
  @Post('devices')
  @HttpCode(HttpStatus.OK)
  async registerDevice(
    @CurrentUser() user: User,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.pushService.registerToken(
      user.id,
      dto.token,
      dto.platform ?? DevicePlatform.Ios,
      dto.appVersion,
    );
  }

  /** Sign out everywhere. Declared before `devices` so it is not shadowed. */
  @Delete('devices/all')
  @HttpCode(HttpStatus.OK)
  async removeAllDevices(@CurrentUser() user: User) {
    return this.pushService.removeAllTokens(user.id);
  }

  /** Called on logout for this device. */
  @Delete('devices')
  @HttpCode(HttpStatus.OK)
  async removeDevice(
    @CurrentUser() user: User,
    @Body() dto: RemoveDeviceTokenDto,
  ) {
    return this.pushService.removeToken(user.id, dto.token);
  }

  /* ------------------------------------------------------------------ */
  /*  Diagnostics                                                         */
  /* ------------------------------------------------------------------ */

  /** Whether Firebase credentials loaded. Useful right after deploying. */
  @Get('status')
  @Roles(UserRole.ADMIN)
  async status() {
    return { firebaseConfigured: this.pushService.isReady };
  }

  /** Admin-only: push straight to a raw token, bypassing the queue and DB. */
  @Post('test-send')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async testSend(@Body() dto: SendTestNotificationDto) {
    return this.pushService.sendTestToToken(dto.token, dto.title, dto.body);
  }

  /* ------------------------------------------------------------------ */
  /*  Wildcards — must stay last                                          */
  /* ------------------------------------------------------------------ */

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notificationService.markAsRead(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notificationService.remove(user.id, id);
  }
}
