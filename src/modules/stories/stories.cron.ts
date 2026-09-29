import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { StoriesService } from './stories.service';

/**
 * Safety net for the per-story expiry job: anything the queue lost (a Redis
 * flush, a restart while the job was due) is caught here within the quarter
 * hour. Reads filter on expiresAt anyway, so this only keeps `status` honest.
 */
@Injectable()
export class StoriesCron {
  private readonly logger = new Logger(StoriesCron.name);
  private running = false;

  constructor(private readonly stories: StoriesService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const expired = await this.stories.expireDue();
      if (expired) this.logger.log(`expired ${expired} stories`);
    } catch (error) {
      this.logger.error(`story sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
