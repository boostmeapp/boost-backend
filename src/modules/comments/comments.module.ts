import { Module } from '@nestjs/common';
import { BoostCampaignsModule } from '../boost-campaigns/boost-campaigns.module';
import { MongooseModule } from '@nestjs/mongoose';
import { Comment, CommentSchema } from './comment.schema';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { Video, VideoSchema } from 'src/database/schemas/video/video.schema';
import {
  CommentLike,
  CommentLikeSchema,
} from '../../database/schemas/comment-like/comment-like.schema';
import {
  Report,
  ReportSchema,
} from '../../database/schemas/report/report.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Comment.name, schema: CommentSchema },
      { name: Video.name, schema: VideoSchema },
      { name: CommentLike.name, schema: CommentLikeSchema },
      { name: Report.name, schema: ReportSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BoostCampaignsModule,
  ],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
