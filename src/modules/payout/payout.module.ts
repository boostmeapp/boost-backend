import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bull';
import { PayoutService } from './payout.service';
import { PayoutController } from './payout.controller';
import { PayoutProcessor } from './payout.processor';
import { PayoutScheduler } from './payout.scheduler';
import {
  Payout,
  PayoutSchema,
} from '../../database/schemas/payout/payout.schema';
import {
  PayoutLog,
  PayoutLogSchema,
} from '../../database/schemas/payout/payout-log.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import {
  Wallet,
  WalletSchema,
} from '../../database/schemas/wallet/wallet.schema';
import {
  Transaction,
  TransactionSchema,
} from '../../database/schemas/transaction/transaction.schema';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payout.name, schema: PayoutSchema },
      { name: PayoutLog.name, schema: PayoutLogSchema },
      { name: User.name, schema: UserSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    BullModule.registerQueue({
      name: 'payouts',
    }),
    StripeConnectModule,
  ],
  controllers: [PayoutController],
  providers: [PayoutService, PayoutProcessor, PayoutScheduler],
  exports: [PayoutService],
})
export class PayoutModule {}
