import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Call } from '../../database/schemas/call/call.schema';
import { ENV } from '../../config';
import { RedisService } from '../redis/redis.service';
import { StreamVideoService } from './stream-video.service';
import { CallService } from './call.service';
import { CallMetricsService } from './call-metrics.service';
import {
  CallEndReason,
  CallStatus,
  SWEEP_ACTIVE_MAX_SECONDS,
  SWEEP_LOCK_TTL_SECONDS,
  SWEEP_RINGING_GRACE_SECONDS,
} from './call.constants';

const SWEEP_LOCK_KEY = 'call:sweeper-lock';

export interface SweepResult {
  missed: number;
  ended: number;
  /** False when another replica held the lock and this run did nothing. */
  ran: boolean;
}

/**
 * The safety net under the ring-timeout job and the webhook: guarantees no
 * call stays ringing or active forever. A non-zero catch count means one of
 * those delivery paths is broken, so it is logged as a warning, not quietly.
 */
@Injectable()
export class CallSweeperCron {
  private readonly logger = new Logger(CallSweeperCron.name);
  private running = false;

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<Call>,
    private readonly callService: CallService,
    private readonly streamVideo: StreamVideoService,
    private readonly redis: RedisService,
    private readonly metrics: CallMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<SweepResult> {
    if (this.running) return { missed: 0, ended: 0, ran: false };
    this.running = true;

    // Single-flight across replicas. If Redis itself is down, sweep anyway:
    // that is exactly when ring-timeout jobs are missing, and every
    // transition is idempotent, so a duplicate sweep is harmless.
    const token = randomUUID();
    let locked = false;
    try {
      locked = await this.redis.setIfAbsent(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_SECONDS, token);
      if (!locked) {
        this.running = false;
        return { missed: 0, ended: 0, ran: false };
      }
    } catch (err) {
      this.logger.warn(`Sweeper lock unavailable, sweeping without it: ${(err as Error).message}`);
    }

    try {
      const missed = await this.sweepRinging();
      const ended = await this.sweepActive();
      if (missed || ended) {
        await this.metrics.recordSweeperCatches(missed + ended);
        this.logger.warn(
          `Call sweep caught ${missed} stuck ringing and ${ended} orphaned active call(s) — check the ring-timeout queue and webhook delivery`,
        );
      }
      return { missed, ended, ran: true };
    } catch (err) {
      this.logger.error(`Call sweep failed: ${(err as Error).message}`);
      return { missed: 0, ended: 0, ran: true };
    } finally {
      if (locked) await this.redis.deleteIfEquals(SWEEP_LOCK_KEY, token).catch(() => false);
      this.running = false;
    }
  }

  /** Ringing past the timeout plus a grace period → missed (and stop the ring). */
  private async sweepRinging(): Promise<number> {
    const cutoff = new Date(
      Date.now() - (ENV.CALL_RING_TIMEOUT_SECONDS + SWEEP_RINGING_GRACE_SECONDS) * 1000,
    );
    // Served by the { status, ringStartedAt } index.
    const stuck = await this.callModel
      .find({ status: CallStatus.Ringing, ringStartedAt: { $lt: cutoff } })
      .select('_id')
      .lean();

    let count = 0;
    for (const c of stuck) {
      if (await this.callService.expireRingingCall(c._id)) count++;
    }
    return count;
  }

  /**
   * Active with an answer older than the cap → ended (network_failure), with
   * the duration capped so one stuck record can't corrupt analytics.
   */
  private async sweepActive(): Promise<number> {
    const cutoff = new Date(Date.now() - SWEEP_ACTIVE_MAX_SECONDS * 1000);
    const stuck = await this.callModel
      .find({ status: CallStatus.Active, answeredAt: { $lt: cutoff } })
      .select('_id streamCallId')
      .lean();

    let count = 0;
    for (const c of stuck) {
      try {
        const { changed } = await this.callService.applyTransition(c._id, CallStatus.Ended, {
          actorId: null,
          reason: CallEndReason.NetworkFailure,
          maxDurationSeconds: SWEEP_ACTIVE_MAX_SECONDS,
        });
        if (!changed) continue;
        count++;
      } catch (err) {
        this.logger.warn(`Sweep: ${c._id} not ended: ${(err as Error).message}`);
        continue;
      }
      await this.streamVideo
        .endCall(c.streamCallId)
        .catch((err) => this.logger.warn(`Sweep: Stream end failed for ${c._id}: ${err.message}`));
    }
    return count;
  }
}
