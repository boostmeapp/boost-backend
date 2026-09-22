import { Module } from '@nestjs/common';
import { BoostCampaignsModule } from '../boost-campaigns/boost-campaigns.module';
import { MongooseModule } from '@nestjs/mongoose';
import { LikesService } from './likes.service';
import { Like, LikeSchema } from '../../database/schemas/like/like.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Like.name, schema: LikeSchema },
      { name: Video.name, schema: VideoSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BoostCampaignsModule,
  ],
  providers: [LikesService],
  exports: [LikesService],
})
export class LikesModule {}
