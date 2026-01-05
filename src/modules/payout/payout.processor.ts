import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { PayoutService } from './payout.service';

@Processor('payouts')
export class PayoutProcessor {
  private readonly logger = new Logger(PayoutProcessor.name);

  constructor(private readonly payoutService: PayoutService) {}

  @Process('process-payout')
  async handlePayoutProcessing(job: Job<{ payoutId: string }>) {
    const { payoutId } = job.data;
    this.logger.log(`Processing payout job for payout ID: ${payoutId}`);

    try {
      const result = await this.payoutService.processPayout(payoutId);

      if (result.success) {
        this.logger.log(
          `Payout ${payoutId} processed successfully: ${result.message}`,
        );
        return result;
      } else {
        this.logger.warn(
          `Payout ${payoutId} processing failed: ${result.message}`,
        );
        // Don't throw error if retry is scheduled
        if (result.message.includes('retry scheduled')) {
          return result;
        }
        throw new Error(result.message);
      }
    } catch (error) {
      this.logger.error(
        `Error processing payout ${payoutId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @Process('batch-payouts')
  async handleBatchPayouts(job: Job<{ batchId?: string }>) {
    const { batchId } = job.data;
    this.logger.log(`Processing batch payouts with batch ID: ${batchId}`);

    try {
      const stats = await this.payoutService.initiateScheduledPayouts(batchId);

      this.logger.log(`Batch payouts completed`, stats);
      return stats;
    } catch (error) {
      this.logger.error(
        `Error processing batch payouts: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
