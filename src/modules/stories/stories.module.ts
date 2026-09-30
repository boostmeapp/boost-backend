import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bull';

import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { StoriesCron } from './stories.cron';
import { StoriesExpiryProcessor } from './stories-expiry.processor';
import { STORY_QUEUE } from './stories.constants';
import { ChatModule } from '../chat/chat.module';
import { FollowsModule } from '../follows/follows.module';
import { UploadModule } from '../upload/upload.module';
import { Story, StorySchema } from '../../database/schemas/story/story.schema';
import {
  StoryView,
  StoryViewSchema,
} from '../../database/schemas/story/story-view.schema';
import { User, UserSchema } from '../../database/schemas/user/user.schema';

// The Bull root connection and ScheduleModule are configured in AppModule.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Story.name, schema: StorySchema },
      { name: StoryView.name, schema: StoryViewSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BullModule.registerQueue({ name: STORY_QUEUE }),
    FollowsModule,
    ChatModule,
    UploadModule,
  ],
  controllers: [StoriesController],
  providers: [StoriesService, StoriesCron, StoriesExpiryProcessor],
  exports: [StoriesService],
})
export class StoriesModule {}
