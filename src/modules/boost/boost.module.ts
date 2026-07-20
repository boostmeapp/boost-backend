import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BoostController } from './boost.controller';
import { BoostService } from './boost.service';
import { IapValidationService } from './iap-validation.service';
import { Boost, BoostSchema } from '../../database/schemas/boost/boost.schema';
import {
  BoostProduct,
  BoostProductSchema,
} from '../../database/schemas/boost-product/boost-product.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { WalletModule } from '../wallet/wallet.module';
import { TransactionModule } from '../transaction/transaction.module';
import { RewardModule } from '../reward/reward.module';
import { CoinsModule } from '../coins/coins.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Boost.name, schema: BoostSchema },
      { name: BoostProduct.name, schema: BoostProductSchema },
      { name: Video.name, schema: VideoSchema },
    ]),
    WalletModule,
    TransactionModule,
    forwardRef(() => RewardModule),
    CoinsModule,
  ],
  controllers: [BoostController],
  providers: [BoostService, IapValidationService],
  exports: [BoostService],
})
export class BoostModule {}
