import {
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
} from './call.constants';

const rateKey = (callerId: string) => `call:rate:${callerId}`;

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
}
