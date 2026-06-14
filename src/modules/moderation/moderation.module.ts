import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';
import { Report, ReportSchema } from '../../database/schemas/report/report.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Comment, CommentSchema } from '../comments/comment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: Video.name, schema: VideoSchema },
      { name: User.name, schema: UserSchema },
      { name: Comment.name, schema: CommentSchema },
    ]),
  ],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
