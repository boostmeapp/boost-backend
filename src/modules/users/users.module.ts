import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { FollowsModule } from '../follows/follows.module';
import { VideoModule } from '../video/video.module';
import { Follow, FollowSchema } from 'src/database/schemas/follow/follow.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Video.name, schema: VideoSchema }, // ✅ ADD
        { name: Follow.name, schema: FollowSchema },
    ]),
    FollowsModule, // ✅ ADD
    VideoModule
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
