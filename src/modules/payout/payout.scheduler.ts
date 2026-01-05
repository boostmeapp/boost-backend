import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import { PayoutService } from './payout.service';

@Injectable()
export class PayoutScheduler {
  private readonly logger = new Logger(PayoutScheduler.name);

  constructor(
    @InjectQueue('payouts') private payoutQueue: Queue,
    private payoutService: PayoutService,
  ) {}

  /**
   * Scheduled weekly payout job - runs every Monday at 9:00 AM
   * You can customize the cron expression:
   * - @Cron('0 9 * * 1') - Every Monday at 9:00 AM
   * - @Cron('0 0 * * 0') - Every Sunday at midnight
   * - CronExpression.EVERY_WEEK - Every Sunday at midnight (built-in)
   */
  @Cron('0 9 * * 1', {
    name: 'weekly-payouts',
    timeZone: 'Europe/London', // Adjust to your timezone
  })
  async handleWeeklyPayouts() {
    const batchId = `weekly_${new Date().toISOString().split('T')[0]}_${uuidv4()}`;

    this.logger.log(`Triggering weekly payout batch: ${batchId}`);

    try {
      // Queue the batch job to avoid blocking the scheduler
      await this.payoutQueue.add(
        'batch-payouts',
        { batchId },
        {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      this.logger.log(`Weekly payout batch ${batchId} queued successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to queue weekly payout batch: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Retry failed payouts - runs every hour
   * Checks for payouts that have nextRetryAt in the past and re-queues them
   */
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'retry-failed-payouts',
  })
  async handleRetryFailedPayouts() {
    this.logger.log('Checking for failed payouts to retry');

    try {
      const retriedCount = await this.payoutService.retryFailedPayouts();

      if (retriedCount > 0) {
        this.logger.log(`Queued ${retriedCount} failed payouts for retry`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to retry payouts: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Optional: Daily payout job - for testing or alternative schedules
   * Uncomment to enable daily payouts instead of weekly
   */
  // @Cron(CronExpression.EVERY_DAY_AT_NOON, {
  //   name: 'daily-payouts',
  // })
  // async handleDailyPayouts() {
  //   const batchId = `daily_${new Date().toISOString().split('T')[0]}_${uuidv4()}`;
  //
  //   this.logger.log(`Triggering daily payout batch: ${batchId}`);
  //
  //   try {
  //     await this.payoutQueue.add(
  //       'batch-payouts',
  //       { batchId },
  //       {
  //         attempts: 1,
  //         removeOnComplete: false,
  //         removeOnFail: false,
  //       },
  //     );
  //
  //     this.logger.log(`Daily payout batch ${batchId} queued successfully`);
  //   } catch (error) {
  //     this.logger.error(
  //       `Failed to queue daily payout batch: ${error.message}`,
  //       error.stack,
  //     );
  //   }
  // }
}
