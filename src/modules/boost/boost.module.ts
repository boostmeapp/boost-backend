import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BoostController } from './boost.controller';
import { BoostService } from './boost.service';
import { Boost, BoostSchema } from '../../database/schemas/boost/boost.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { WalletModule } from '../wallet/wallet.module';
import { TransactionModule } from '../transaction/transaction.module';
import { RewardModule } from '../reward/reward.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Boost.name, schema: BoostSchema },
      { name: Video.name, schema: VideoSchema },
    ]),
    WalletModule,
    TransactionModule,
    forwardRef(() => RewardModule),
  ],
  controllers: [BoostController],
  providers: [BoostService],
  exports: [BoostService],
})
export class BoostModule {}
