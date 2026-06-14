import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { Report, ReportSchema } from '../../database/schemas/report/report.schema';
import { Comment, CommentSchema } from '../comments/comment.schema';
import { WalletModule } from '../wallet/wallet.module';
import { TransactionModule } from '../transaction/transaction.module';
import { BoostModule } from '../boost/boost.module';
import { RewardModule } from '../reward/reward.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Video.name, schema: VideoSchema },
      { name: Report.name, schema: ReportSchema },
      { name: Comment.name, schema: CommentSchema },
    ]),
    WalletModule,
    TransactionModule,
    BoostModule,
    RewardModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
