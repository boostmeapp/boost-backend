import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RewardController } from './reward.controller';
import { RewardService } from './reward.service';
import { VideoReward, VideoRewardSchema } from '../../database/schemas/reward/video-reward.schema';
import {
  UserEarning,
  UserEarningSchema,
  UserRewardBalance,
  UserRewardBalanceSchema,
  RewardPoolStats,
  RewardPoolStatsSchema,
} from '../../database/schemas/reward/user-earning.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { Boost, BoostSchema } from '../../database/schemas/boost/boost.schema';
import { TransactionModule } from '../transaction/transaction.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VideoReward.name, schema: VideoRewardSchema },
      { name: UserEarning.name, schema: UserEarningSchema },
      { name: UserRewardBalance.name, schema: UserRewardBalanceSchema },
      { name: RewardPoolStats.name, schema: RewardPoolStatsSchema },
      { name: Video.name, schema: VideoSchema },
      { name: Boost.name, schema: BoostSchema },
    ]),
    TransactionModule,
  ],
  controllers: [RewardController],
  providers: [RewardService],
  exports: [RewardService],
})
export class RewardModule {}
