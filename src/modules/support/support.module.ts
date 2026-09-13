import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { DataExportService } from './data-export.service';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { Comment, CommentSchema } from '../comments/comment.schema';
import { Follow, FollowSchema } from '../../database/schemas/follow/follow.schema';
import { Like, LikeSchema } from '../../database/schemas/like/like.schema';
import {
  Transaction,
  TransactionSchema,
} from '../../database/schemas/transaction/transaction.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Video.name, schema: VideoSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: Like.name, schema: LikeSchema },
      { name: Transaction.name, schema: TransactionSchema },
    ]),
  ],
  controllers: [SupportController],
  providers: [SupportService, DataExportService],
})
export class SupportModule {}
