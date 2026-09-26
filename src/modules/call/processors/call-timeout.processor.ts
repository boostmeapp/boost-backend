import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { CallService } from '../call.service';
import { CALL_QUEUE, CallJobs, RingTimeoutJob } from '../call.constants';

/**
 * Fires CALL_RING_TIMEOUT_SECONDS after a call starts ringing. Never relies on
 * the job having been cancelled: it re-reads the call and only acts if it is
 * still ringing, so an answer at the boundary always wins.
 */
@Processor(CALL_QUEUE)
export class CallTimeoutProcessor {
  private readonly logger = new Logger(CallTimeoutProcessor.name);

  constructor(private readonly callService: CallService) {}

  @Process(CallJobs.RingTimeout)
  async handleRingTimeout(job: Job<RingTimeoutJob>): Promise<void> {
    const { callId } = job.data ?? {};
    if (!callId) return;

    const expired = await this.callService.expireRingingCall(callId, {
      fromRingTimeout: true,
    });
    if (expired) {
      this.logger.log(`Call ${callId} missed (ring timeout)`);
    }
  }
}
