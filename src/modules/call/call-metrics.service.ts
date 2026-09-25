import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Call } from '../../database/schemas/call/call.schema';
import { ENV } from '../../config';
import { RedisService } from '../redis/redis.service';
import { ANSWER_RATE_ALERT_MIN_SAMPLE, CallStatus } from './call.constants';

/** Hourly bucket key for sweeper catches, e.g. call:metrics:sweep-caught:2026092514. */
const sweepBucketKey = (d: Date) =>
  `call:metrics:sweep-caught:${d.toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
const SWEEP_BUCKET_TTL_SECONDS = 31 * 24 * 3600;
/** Cap on answered calls read for latency percentiles. */
const LATENCY_SAMPLE_CAP = 10_000;

export interface CallMetrics {
  window: { from: Date; to: Date; hours: number };
  initiated: number;
  answered: number;
  missed: number;
  rejected: number;
  cancelled: number;
  failed: number;
  /** Still ringing or active. */
  live: number;
  /**
   * answered / (answered + missed + rejected) — calls the callee actually had a
   * chance to pick up. Null with no such calls. The single best signal that
   * push delivery has broken.
   */
  answerRate: number | null;
  ringToAnswerSeconds: { p50: number | null; p95: number | null; samples: number };
  /** Stuck calls the sweeper had to close. Should hover near zero. */
  sweeperCaught: number;
  /**
   * Post-call ratings: how many were given, and the share at 1–2 stars.
   * Catches quality regressions that packet stats miss.
   */
  ratings: { count: number; lowShare: number | null };
}

/** Nearest-rank percentile of an ascending array. */
export const percentile = (sorted: number[], p: number): number | null => {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

@Injectable()
export class CallMetricsService {
  private readonly logger = new Logger(CallMetricsService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<Call>,
    private readonly redis: RedisService,
  ) {}

  /** Called by the sweeper after each run that caught something. */
  async recordSweeperCatches(n: number): Promise<void> {
    if (n <= 0) return;
    await this.redis
      .incrByWithTtl(sweepBucketKey(new Date()), n, SWEEP_BUCKET_TTL_SECONDS)
      .catch((err) => this.logger.warn(`Sweeper metric not recorded: ${err.message}`));
  }

  /** Aggregated over createdAt in the window (served by the { createdAt: -1 } index). */
  async compute(hours = 24): Promise<CallMetrics> {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    const range = { createdAt: { $gte: from, $lte: to } };

    const [byStatus, answeredRows, sweeperCaught, ratingRows] = await Promise.all([
      this.callModel.aggregate<{ _id: CallStatus; count: number; answered: number }>([
        { $match: range },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            answered: { $sum: { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] } },
          },
        },
      ]),
      this.callModel
        .find({ ...range, answeredAt: { $ne: null } })
        .select('ringStartedAt answeredAt')
        .limit(LATENCY_SAMPLE_CAP)
        .lean(),
      this.sweeperCaughtSince(from, to),
      // metadata.feedback is keyed by rater id; flatten to one row per rating.
      this.callModel.aggregate<{ count: number; low: number }>([
        { $match: { ...range, 'metadata.feedback': { $exists: true } } },
        { $project: { ratings: { $objectToArray: '$metadata.feedback' } } },
        { $unwind: '$ratings' },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            low: { $sum: { $cond: [{ $lte: ['$ratings.v.rating', 2] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const count = (s: CallStatus) => byStatus.find((r) => r._id === s)?.count ?? 0;
    const initiated = byStatus.reduce((n, r) => n + r.count, 0);
    const answered = byStatus.reduce((n, r) => n + r.answered, 0);
    const missed = count(CallStatus.Missed);
    const rejected = count(CallStatus.Rejected);
    const answerable = answered + missed + rejected;

    const latencies = answeredRows
      .map((c) => (new Date(c.answeredAt!).getTime() - new Date(c.ringStartedAt).getTime()) / 1000)
      .filter((s) => Number.isFinite(s) && s >= 0)
      .sort((a, b) => a - b);

    return {
      window: { from, to, hours },
      initiated,
      answered,
      missed,
      rejected,
      cancelled: count(CallStatus.Cancelled),
      failed: count(CallStatus.Failed),
      live: count(CallStatus.Ringing) + count(CallStatus.Active),
      answerRate: answerable ? Math.round((answered / answerable) * 1000) / 1000 : null,
      ringToAnswerSeconds: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        samples: latencies.length,
      },
      sweeperCaught,
      ratings: {
        count: ratingRows[0]?.count ?? 0,
        lowShare: ratingRows[0]?.count
          ? Math.round((ratingRows[0].low / ratingRows[0].count) * 1000) / 1000
          : null,
      },
    };
  }

  /**
   * Hourly: alert when the answer rate drops below the floor. A dead VoIP
   * credential looks exactly like this and is otherwise invisible. The alert
   * is an ERROR log line starting "ALERT" — point log-based alerting at it.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkAnswerRate(): Promise<void> {
    // One replica per hour. If Redis is down, check anyway — a duplicate alert
    // beats a missing one.
    const hour = new Date().toISOString().slice(0, 13);
    const first = await this.redis
      .setIfAbsent(`call:answer-rate-check:${hour}`, 3600)
      .catch(() => true);
    if (!first) return;

    try {
      const m = await this.compute(1);
      const sample = m.answered + m.missed + m.rejected;
      if (sample < ANSWER_RATE_ALERT_MIN_SAMPLE || m.answerRate === null) return;
      if (m.answerRate < ENV.CALL_ANSWER_RATE_ALERT_FLOOR) {
        this.logger.error(
          `ALERT call answer rate ${(m.answerRate * 100).toFixed(1)}% over the last hour ` +
            `(${m.answered} answered, ${m.missed} missed, ${m.rejected} rejected) is below ` +
            `${ENV.CALL_ANSWER_RATE_ALERT_FLOOR * 100}% — check push delivery first ` +
            `(docs/video-calling-push-runbook.md)`,
        );
      }
    } catch (err) {
      this.logger.error(`Answer-rate check failed: ${(err as Error).message}`);
    }
  }

  private async sweeperCaughtSince(from: Date, to: Date): Promise<number> {
    const keys: string[] = [];
    for (let t = new Date(from); t <= to; t = new Date(t.getTime() + 3600 * 1000)) {
      keys.push(sweepBucketKey(t));
    }
    const last = sweepBucketKey(to);
    if (!keys.includes(last)) keys.push(last);
    try {
      const values = await this.redis.getValues(keys);
      return values.reduce((n, v) => n + (Number(v) || 0), 0);
    } catch {
      return 0;
    }
  }
}
