import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ENV } from '../../config';
import { RedisService } from '../redis/redis.service';
import {
  CALL_RATE_WINDOW_SECONDS,
  CallErrorCode,
  REJECT_BACKOFF_SECONDS,
  REJECT_BACKOFF_THRESHOLD,
  REJECT_WINDOW_SECONDS,
} from './call.constants';

const rateKey = (callerId: string) => `call:rate:${callerId}`;
const rejectKey = (callerId: string, calleeId: string) => `call:reject:${callerId}:${calleeId}`;
const backoffKey = (callerId: string, calleeId: string) => `call:backoff:${callerId}:${calleeId}`;

/**
 * Per-caller limits beyond the global throttler. Every check FAILS OPEN on a
 * Redis error: a Redis outage must not take calling down entirely. (The
 * initiation lock in CallService deliberately fails closed instead — there,
 * failing open risks a double ring; here, failing closed risks a full outage.)
 */
@Injectable()
export class CallAbuseService {
  private readonly logger = new Logger(CallAbuseService.name);

  constructor(private readonly redis: RedisService) {}

  /** 429 CALL_RATE_LIMITED once the caller has started CALL_MAX_PER_HOUR calls in the last hour. */
  async assertWithinRateLimit(callerId: string): Promise<void> {
    let count: number;
    try {
      count = await this.redis.slidingWindowCount(rateKey(callerId), CALL_RATE_WINDOW_SECONDS);
    } catch (err) {
      this.logger.warn(`Rate limit check skipped (Redis): ${(err as Error).message}`);
      return;
    }
    if (count >= ENV.CALL_MAX_PER_HOUR) {
      this.logger.log(`Call rate limit hit by ${callerId} (${count}/h)`);
      throw new HttpException(
        {
          message: "You've made too many calls. Please try again later.",
          code: CallErrorCode.CallRateLimited,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Count a successfully started call against the caller's hourly limit. */
  async recordInitiation(callerId: string): Promise<void> {
    await this.redis
      .slidingWindowAdd(rateKey(callerId), CALL_RATE_WINDOW_SECONDS)
      .catch((err) => this.logger.warn(`Rate limit not recorded (Redis): ${err.message}`));
  }

  /**
   * Refuse a caller the callee has repeatedly rejected. Answers exactly like a
   * block (USER_UNAVAILABLE) — telling a harasser they are being throttled
   * only tells them when to try again.
   */
  async assertNotBackedOff(callerId: string, calleeId: string): Promise<void> {
    let backedOff: boolean;
    try {
      backedOff = await this.redis.existsKey(backoffKey(callerId, calleeId));
    } catch (err) {
      this.logger.warn(`Reject-backoff check skipped (Redis): ${(err as Error).message}`);
      return;
    }
    if (backedOff) {
      this.logger.log(`Call ${callerId} -> ${calleeId} refused: reject backoff`);
      throw new ForbiddenException({
        message: "This user can't be called right now",
        code: CallErrorCode.UserUnavailable,
      });
    }
  }

  /** A deliberate rejection by the callee. The third within the window starts the backoff. */
  async recordRejection(callerId: string, calleeId: string): Promise<void> {
    try {
      const n = await this.redis.incrWithTtl(rejectKey(callerId, calleeId), REJECT_WINDOW_SECONDS);
      if (n >= REJECT_BACKOFF_THRESHOLD) {
        await this.redis.setValue(backoffKey(callerId, calleeId), '1', REJECT_BACKOFF_SECONDS);
        await this.redis.delValue(rejectKey(callerId, calleeId));
        this.logger.warn(
          `Reject backoff: ${calleeId} rejected ${callerId} ${n}x within ${REJECT_WINDOW_SECONDS / 60}m; ` +
            `calls blocked for ${REJECT_BACKOFF_SECONDS / 60}m`,
        );
      }
    } catch (err) {
      this.logger.warn(`Rejection not recorded (Redis): ${(err as Error).message}`);
    }
  }
}
