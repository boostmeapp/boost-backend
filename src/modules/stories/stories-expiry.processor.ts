import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';

import { StoriesService } from './stories.service';
import { ExpireStoryJob, STORY_QUEUE, StoryJobs } from './stories.constants';

/**
 * Fires 24 hours after a story is posted. The service re-reads the story and
 * only acts while it is still active and past its time, so a late or repeated
 * run is harmless.
 */
@Processor(STORY_QUEUE)
export class StoriesExpiryProcessor {
  private readonly logger = new Logger(StoriesExpiryProcessor.name);

  constructor(private readonly stories: StoriesService) {}

  @Process(StoryJobs.Expire)
  async handleExpire(job: Job<ExpireStoryJob>): Promise<void> {
    const { storyId } = job.data ?? {};
    if (!storyId) return;

    if (await this.stories.expire(storyId)) {
      this.logger.log(`story ${storyId} expired`);
    }
  }
}
