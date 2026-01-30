import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FeedService } from './feed.service';
import { FeedController } from './feed.controller';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { LikesModule } from '../likes/likes.module';
import { Follow, FollowSchema } from 'src/database/schemas/follow/follow.schema';

@Module({
  imports: [
    MongooseModule.forFeature([ { name: Video.name, schema: VideoSchema },
      { name: Follow.name, schema: FollowSchema },])
    ,
    LikesModule,
  ],
  controllers: [FeedController],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
