import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  BoostCampaign,
  BoostCampaignSchema,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';
import {
  BoostImpression,
  BoostImpressionSchema,
} from '../../database/schemas/boost-campaign/boost-impression.schema';
import {
  BoostView,
  BoostViewSchema,
} from '../../database/schemas/boost-campaign/boost-view.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { CoinsModule } from '../coins/coins.module';
import {
  BoostCampaignsController,
  VideoViewsController,
} from './boost-campaigns.controller';
import { BoostCampaignsCron } from './boost-campaigns.cron';
import { BoostCampaignsService } from './boost-campaigns.service';
import { BoostDeliveryService } from './boost-delivery.service';
import { BoostEngagementService } from './boost-engagement.service';
import { BoostTargetingService } from './boost-targeting.service';
import { VideoViewsService } from './video-views.service';

/**
 * Coin-paid boost campaigns: creation and settlement, feed delivery, view
 * attribution and engagement credit. Plan: docs/boost-campaigns/README.md.
 *
 * Deliberately depends only on models, CoinsModule and the global Redis and
 * Notification modules, so feed, likes, comments and follows can import it
 * without cycles.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BoostCampaign.name, schema: BoostCampaignSchema },
      { name: BoostImpression.name, schema: BoostImpressionSchema },
      { name: BoostView.name, schema: BoostViewSchema },
      { name: Video.name, schema: VideoSchema },
      { name: User.name, schema: UserSchema },
    ]),
    CoinsModule,
  ],
  controllers: [BoostCampaignsController, VideoViewsController],
  providers: [
    BoostCampaignsService,
    BoostTargetingService,
    BoostDeliveryService,
    BoostEngagementService,
    VideoViewsService,
    BoostCampaignsCron,
  ],
  exports: [BoostDeliveryService, BoostEngagementService],
})
export class BoostCampaignsModule {}
