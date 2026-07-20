import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CoinsController } from './coins.controller';
import { CoinsService } from './coins.service';
import { IapValidationService } from '../boost/iap-validation.service';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import {
  CoinPackage,
  CoinPackageSchema,
} from '../../database/schemas/coin/coin-package.schema';
import {
  CoinTransaction,
  CoinTransactionSchema,
} from '../../database/schemas/coin/coin-transaction.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: CoinPackage.name, schema: CoinPackageSchema },
      { name: CoinTransaction.name, schema: CoinTransactionSchema },
    ]),
  ],
  controllers: [CoinsController],
  providers: [CoinsService, IapValidationService],
  exports: [CoinsService],
})
export class CoinsModule {}
