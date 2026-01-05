import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StripeConnectController } from './stripe-connect.controller';
import { StripeConnectTestController } from './stripe-connect-test.controller';
import { StripeConnectService } from './stripe-connect.service';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  controllers: [StripeConnectController, StripeConnectTestController],
  providers: [StripeConnectService],
  exports: [StripeConnectService],
})
export class StripeConnectModule {}
