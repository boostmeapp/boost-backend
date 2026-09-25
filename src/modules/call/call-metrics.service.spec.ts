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
  let answeredRows: { ringStartedAt: Date; answeredAt: Date }[];
  let redis: any;
  let service: CallMetricsService;
  let findFilter: any;

  const answeredAfter = (seconds: number) => {
    const ringStartedAt = new Date(Date.now() - 60_000);
    return { ringStartedAt, answeredAt: new Date(ringStartedAt.getTime() + seconds * 1000) };
  };

  beforeAll(() => {
    ENV.init({ get: (_k: string, fallback: unknown) => fallback } as any);
  });

  beforeEach(() => {
    groups = [];
    answeredRows = [];
    const callModel = {
      aggregate: jest.fn(async () => groups),
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
});
