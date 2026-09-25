import { ForbiddenException, HttpException } from '@nestjs/common';
import { CallAbuseService } from './call-abuse.service';
import { ENV } from '../../config';
import { CallErrorCode } from './call.constants';

/** In-memory Redis with real sliding-window and TTL behaviour, on a controllable clock. */
class FakeRedis {
  now = 1_800_000_000_000;
  down = false;
  zsets = new Map<string, number[]>();
  kv = new Map<string, { v: string; exp: number | null }>();

  private guard() {
    if (this.down) throw new Error('ECONNREFUSED');
  }
  private live(key: string) {
    const e = this.kv.get(key);
    if (e && e.exp !== null && e.exp <= this.now) this.kv.delete(key);
    return this.kv.get(key);
  }
  async slidingWindowCount(key: string, windowSeconds: number) {
    this.guard();
    const kept = (this.zsets.get(key) ?? []).filter((t) => t > this.now - windowSeconds * 1000);
    this.zsets.set(key, kept);
    return kept.length;
  }
  async slidingWindowAdd(key: string) {
    this.guard();
    this.zsets.set(key, [...(this.zsets.get(key) ?? []), this.now]);
  }
  async incrWithTtl(key: string, ttl: number) {
    this.guard();
    const e = this.live(key);
    const n = Number(e?.v ?? 0) + 1;
    this.kv.set(key, { v: String(n), exp: e ? e.exp : this.now + ttl * 1000 });
    return n;
  }
  async setValue(key: string, v: string, ttl?: number) {
    this.guard();
    this.kv.set(key, { v, exp: ttl ? this.now + ttl * 1000 : null });
  }
  async delValue(key: string) {
    this.guard();
    return this.kv.delete(key) ? 1 : 0;
  }
  async existsKey(key: string) {
    this.guard();
    return !!this.live(key);
  }
}

describe('CallAbuseService', () => {
  let redis: FakeRedis;
  let service: CallAbuseService;
  let env: Record<string, string>;
  const A = 'caller-a';
  const B = 'callee-b';
  const C = 'callee-c';
  const minutes = (m: number) => (redis.now += m * 60_000);

  beforeAll(() => {
    ENV.init({ get: (k: string, fallback: unknown) => env[k] ?? fallback } as any);
  });

  beforeEach(() => {
    env = {};
    redis = new FakeRedis();
    service = new CallAbuseService(redis as any);
    for (const level of ['log', 'warn'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  });

  describe('per-caller rate limit', () => {
    it('1. allows 30 calls in an hour and refuses the 31st with 429 CALL_RATE_LIMITED', async () => {
      for (let i = 0; i < 30; i++) {
        await service.assertWithinRateLimit(A);
        await service.recordInitiation(A);
      }

      const err = await service.assertWithinRateLimit(A).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse().code).toBe(CallErrorCode.CallRateLimited);
    });

    it('is a sliding window: the oldest call ageing out frees a slot', async () => {
      await service.recordInitiation(A); // t=0
      minutes(30);
      for (let i = 0; i < 29; i++) await service.recordInitiation(A); // t=30m
      await expect(service.assertWithinRateLimit(A)).rejects.toBeInstanceOf(HttpException);

      minutes(31); // t=61m: the t=0 call is out of the window
      await expect(service.assertWithinRateLimit(A)).resolves.toBeUndefined();
    });

    it('is per caller', async () => {
      for (let i = 0; i < 30; i++) await service.recordInitiation(A);

      await expect(service.assertWithinRateLimit('someone-else')).resolves.toBeUndefined();
    });

    it('honours CALL_MAX_PER_HOUR', async () => {
      env.CALL_MAX_PER_HOUR = '2';
      await service.recordInitiation(A);
      await service.recordInitiation(A);

      await expect(service.assertWithinRateLimit(A)).rejects.toBeInstanceOf(HttpException);
    });

    it('6. fails OPEN when Redis is down', async () => {
      redis.down = true;

      await expect(service.assertWithinRateLimit(A)).resolves.toBeUndefined();
      await expect(service.recordInitiation(A)).resolves.toBeUndefined();
    });
  });

  describe('repeat-rejection backoff', () => {
    it('2. three rejections by the same callee within an hour block that pair', async () => {
      await service.recordRejection(A, B);
      await service.recordRejection(A, B);
      await expect(service.assertNotBackedOff(A, B)).resolves.toBeUndefined();

      await service.recordRejection(A, B);

      const err = await service.assertNotBackedOff(A, B).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      // Answers like a block: a harasser learns nothing about the throttle.
      expect(err.getResponse()).toEqual({
        message: "This user can't be called right now",
        code: CallErrorCode.UserUnavailable,
      });
    });

    it('2b. the backoff expires after an hour', async () => {
      for (let i = 0; i < 3; i++) await service.recordRejection(A, B);
      minutes(59);
      await expect(service.assertNotBackedOff(A, B)).rejects.toBeInstanceOf(ForbiddenException);

      minutes(2);
      await expect(service.assertNotBackedOff(A, B)).resolves.toBeUndefined();
    });

    it('only affects that pair — the caller can still call others', async () => {
      for (let i = 0; i < 3; i++) await service.recordRejection(A, B);

      await expect(service.assertNotBackedOff(A, C)).resolves.toBeUndefined();
      await expect(service.assertNotBackedOff(B, A)).resolves.toBeUndefined();
    });

    it('rejections spread over more than an hour do not add up', async () => {
      await service.recordRejection(A, B);
      await service.recordRejection(A, B);
      minutes(61);
      await service.recordRejection(A, B);

      await expect(service.assertNotBackedOff(A, B)).resolves.toBeUndefined();
    });

    it('fails OPEN when Redis is down', async () => {
      redis.down = true;

      await expect(service.recordRejection(A, B)).resolves.toBeUndefined();
      await expect(service.assertNotBackedOff(A, B)).resolves.toBeUndefined();
    });
  });
});
