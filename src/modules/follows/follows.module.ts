import { Module } from '@nestjs/common';
import { BoostCampaignsModule } from '../boost-campaigns/boost-campaigns.module';
import { MongooseModule } from '@nestjs/mongoose';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
import { ConnectionsService } from './connections.service';
import { ConnectionsController } from './connections.controller';
import { Follow, FollowSchema } from '../../database/schemas/follow/follow.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Follow.name, schema: FollowSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BoostCampaignsModule,
  ],
  controllers: [FollowsController, ConnectionsController],
  providers: [FollowsService, ConnectionsService],
  exports: [FollowsService, ConnectionsService],
})
export class FollowsModule {}
