import { CallMetricsService, percentile } from './call-metrics.service';
import { ENV } from '../../config';
import { CallStatus } from './call.constants';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('CallMetricsService', () => {
  let groups: { _id: CallStatus; count: number; answered: number }[];
  let ratingAgg: { count: number; low: number }[];
  let usageAgg: { minutes: number }[];
  let usagePipeline: any[];
  const env: Record<string, string> = {};
  let answeredRows: { ringStartedAt: Date; answeredAt: Date }[];
  let redis: any;
  let service: CallMetricsService;
  let findFilter: any;

  const answeredAfter = (seconds: number) => {
    const ringStartedAt = new Date(Date.now() - 60_000);
    return { ringStartedAt, answeredAt: new Date(ringStartedAt.getTime() + seconds * 1000) };
  };

  beforeAll(() => {
    ENV.init({ get: (k: string, fallback: unknown) => env[k] ?? fallback } as any);
  });

  beforeEach(() => {
    groups = [];
    ratingAgg = [];
    usageAgg = [];
    for (const k of Object.keys(env)) delete env[k];
    answeredRows = [];
    const callModel = {
      // The ratings pipeline is the one that unwinds metadata.feedback.
      aggregate: jest.fn(async (pipeline: any[]) => {
        if (pipeline.some((st) => st.$unwind)) return ratingAgg;
        if (pipeline[0]?.$match?.answeredAt) return (usagePipeline = pipeline), usageAgg;
        return groups;
      }),
      find: jest.fn((f: any) => {
        findFilter = f;
        const chain: any = { select: () => chain, limit: () => chain, lean: async () => answeredRows };
        return chain;
      }),
    };
    redis = {
      getValues: jest.fn(async (keys: string[]) => keys.map((_, i) => (i === 0 ? '2' : null))),
      incrByWithTtl: jest.fn().mockResolvedValue(1),
      setIfAbsent: jest.fn().mockResolvedValue(true),
    };
    service = new CallMetricsService(callModel as any, redis);
    for (const level of ['error', 'warn'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  });

  it('computes counts, answer rate, ring-to-answer percentiles, and sweeper catches', async () => {
    groups = [
      { _id: CallStatus.Ended, count: 6, answered: 6 },
      { _id: CallStatus.Missed, count: 3, answered: 0 },
      { _id: CallStatus.Rejected, count: 1, answered: 0 },
      { _id: CallStatus.Cancelled, count: 5, answered: 0 },
      { _id: CallStatus.Failed, count: 1, answered: 1 },
      { _id: CallStatus.Active, count: 1, answered: 1 },
    ];
    answeredRows = [2, 3, 4, 5, 6, 8, 10, 30].map(answeredAfter);

    const m = await service.compute(24);

    expect(m).toMatchObject({
      initiated: 17,
      answered: 8,
      missed: 3,
      rejected: 1,
      cancelled: 5,
      failed: 1,
      live: 1,
      // cancelled calls are excluded: the callee never had a real chance to answer
      answerRate: Math.round((8 / 12) * 1000) / 1000,
      sweeperCaught: 2,
    });
    expect(m.ringToAnswerSeconds).toEqual({ p50: 5, p95: 30, samples: 8 });
    expect(findFilter.createdAt.$gte).toEqual(m.window.from);
  });

  it('reports rating count and the share at 1–2 stars', async () => {
    ratingAgg = [{ count: 8, low: 2 }];

    expect((await service.compute(24)).ratings).toEqual({ count: 8, lowShare: 0.25 });
  });

  it('ratings are empty, not NaN, when nobody rated', async () => {
    expect((await service.compute(24)).ratings).toEqual({ count: 0, lowShare: null });
  });

  it('answer rate is null with nothing answerable', async () => {
    groups = [{ _id: CallStatus.Cancelled, count: 4, answered: 0 }];

    expect((await service.compute(1)).answerRate).toBeNull();
  });

  describe('hourly answer-rate alert', () => {
    const errorLog = () => (service as any).logger.error as jest.Mock;

    it('7. logs an ALERT when the rate drops below the 40% floor', async () => {
      groups = [
        { _id: CallStatus.Ended, count: 3, answered: 3 },
        { _id: CallStatus.Missed, count: 9, answered: 0 },
      ];

      await service.checkAnswerRate();

      expect(errorLog()).toHaveBeenCalledWith(expect.stringMatching(/^ALERT call answer rate 25\.0%/));
    });

    it('stays quiet above the floor', async () => {
      groups = [
        { _id: CallStatus.Ended, count: 8, answered: 8 },
        { _id: CallStatus.Missed, count: 4, answered: 0 },
      ];

      await service.checkAnswerRate();

      expect(errorLog()).not.toHaveBeenCalled();
    });

    it('does not alert on too small a sample', async () => {
      groups = [{ _id: CallStatus.Missed, count: 5, answered: 0 }];

      await service.checkAnswerRate();

      expect(errorLog()).not.toHaveBeenCalled();
    });

    it('runs on one replica per hour', async () => {
      redis.setIfAbsent.mockResolvedValue(false);
      groups = [{ _id: CallStatus.Missed, count: 20, answered: 0 }];

      await service.checkAnswerRate();

      expect(errorLog()).not.toHaveBeenCalled();
    });

    it('still checks when Redis is down', async () => {
      redis.setIfAbsent.mockRejectedValue(new Error('down'));
      groups = [{ _id: CallStatus.Missed, count: 20, answered: 0 }];

      await service.checkAnswerRate();

      expect(errorLog()).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
    });
  });

  it('records sweeper catches in an hourly bucket', async () => {
    await service.recordSweeperCatches(3);

    expect(redis.incrByWithTtl).toHaveBeenCalledWith(
      expect.stringMatching(/^call:metrics:sweep-caught:\d{10}$/),
      3,
      expect.any(Number),
    );
  });

  describe('usage / cost monitoring (Iteration 13)', () => {
    it('7. month-to-date participant minutes: started minutes × participants, since the 1st (UTC)', async () => {
      usageAgg = [{ minutes: 7000 }];
      env.CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE = '10000';

      const u = await service.monthToDateUsage(new Date('2026-09-25T12:00:00Z'));

      expect(u).toEqual({
        monthStart: new Date('2026-09-01T00:00:00Z'),
        participantMinutes: 7000,
        allowance: 10000,
        share: 0.7,
      });
      expect(usagePipeline[0].$match.answeredAt.$gte).toEqual(new Date('2026-09-01T00:00:00Z'));
      expect(JSON.stringify(usagePipeline[1])).toContain('$ceil');
      expect(JSON.stringify(usagePipeline[1])).toContain('$participants');
    });

    it('no allowance configured → share null, and no alert', async () => {
      usageAgg = [{ minutes: 99999 }];

      expect((await service.monthToDateUsage()).share).toBeNull();
      await service.checkUsage();
      expect((service as any).logger.error).not.toHaveBeenCalled();
    });

    it('alerts at 70% of the allowance', async () => {
      env.CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE = '1000';
      usageAgg = [{ minutes: 700 }];

      await service.checkUsage();

      expect((service as any).logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/^ALERT call usage at 70\.0% of the monthly allowance/),
      );
    });

    it('quiet below 70%', async () => {
      env.CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE = '1000';
      usageAgg = [{ minutes: 699 }];

      await service.checkUsage();

      expect((service as any).logger.error).not.toHaveBeenCalled();
    });

    it('usage is included in the metrics endpoint', async () => {
      usageAgg = [{ minutes: 42 }];

      expect((await service.compute(24)).usage.participantMinutes).toBe(42);
    });
  });
});
