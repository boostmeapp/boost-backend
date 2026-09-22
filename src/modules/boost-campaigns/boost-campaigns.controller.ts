import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  RolesGuard,
} from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import {
  BoostCampaign,
  CampaignStatus,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { BoostCampaignsService } from './boost-campaigns.service';
import { VideoViewsService } from './video-views.service';
import {
  CreateCampaignDto,
  EstimateCampaignDto,
  ListCampaignsQueryDto,
  ReportViewDto,
} from './dto';

/**
 * Coin-paid boost campaigns. Shares the /boost prefix with the legacy
 * BoostController (quote/promote/IAP), whose routes don't overlap these.
 */
@Controller('boost')
@UseGuards(JwtAuthGuard)
export class BoostCampaignsController {
  constructor(
    private readonly campaigns: BoostCampaignsService,
    @InjectModel(BoostCampaign.name)
    private readonly campaignModel: Model<BoostCampaign>,
  ) {}

  /** Prices, durations and targeting options — the app renders from this. */
  @Get('config')
  getConfig() {
    return this.campaigns.getConfig();
  }

  /** Real reach for a targeting + coins combo. No charge. */
  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  estimate(@CurrentUser() user: User, @Body() dto: EstimateCampaignDto) {
    return this.campaigns.estimate(String(user._id), dto);
  }

  /** "Boost Now". Requires an Idempotency-Key header (one per tap). */
  @Post('campaigns')
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateCampaignDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.campaigns.create(String(user._id), dto, idempotencyKey);
  }

  /** Dashboard tabs: live (active + paused) | past | cancelled. */
  @Get('campaigns')
  list(@CurrentUser() user: User, @Query() query: ListCampaignsQueryDto) {
    return this.campaigns.list(String(user._id), query);
  }

  @Get('campaigns/:id')
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.campaigns.findOne(String(user._id), id);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return this.campaigns.cancel(String(user._id), id);
  }

  @Post('campaigns/:id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@CurrentUser() user: User, @Param('id') id: string) {
    return this.campaigns.pause(String(user._id), id);
  }

  @Post('campaigns/:id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@CurrentUser() user: User, @Param('id') id: string) {
    return this.campaigns.resume(String(user._id), id);
  }

  // ── Admin ──────────────────────────────────────────────────────────
  @Get('admin/campaigns')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async adminList(
    @Query('status') status?: CampaignStatus,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.campaignModel
      .find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .populate('user', 'email firstName lastName username')
      .populate('video', 'title thumbnailUrl thumbnailKey duration')
      .lean();
    return rows.map((r) => ({ ...this.campaigns.present(r), user: r.user }));
  }
}

/** POST /videos/:id/views — lives here because it feeds campaign delivery. */
@Controller('videos')
export class VideoViewsController {
  constructor(private readonly views: VideoViewsService) {}

  @Post(':id/views')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(
    @Param('id') id: string,
    @Body() dto: ReportViewDto,
    @CurrentUser() user?: User,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<void> {
    await this.views.report(
      id,
      dto,
      user?._id ? String(user._id) : undefined,
      deviceId,
    );
  }
}
