import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { FollowsModule } from '../follows/follows.module';
import { VideoModule } from '../video/video.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Video.name, schema: VideoSchema }, // ✅ ADD
    ]),
    FollowsModule, // ✅ ADD
    VideoModule
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
