import { Module } from '@nestjs/common';
import { BoostCampaignsModule } from '../boost-campaigns/boost-campaigns.module';
import { MongooseModule } from '@nestjs/mongoose';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
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
  controllers: [FollowsController],
  providers: [FollowsService],
  exports: [FollowsService],
})
export class FollowsModule {}
