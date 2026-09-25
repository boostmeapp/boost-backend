import { Types } from 'mongoose';
import { CallSweeperCron } from './call-sweeper.cron';
import { ENV } from '../../config';
import { CallEndReason, CallStatus, SWEEP_ACTIVE_MAX_SECONDS } from './call.constants';

describe('CallSweeperCron', () => {
  let ringing: any[];
  let active: any[];
  let callModel: { find: jest.Mock };
  let callService: { expireRingingCall: jest.Mock; applyTransition: jest.Mock };
  let streamVideo: { endCall: jest.Mock };
  let redis: { setIfAbsent: jest.Mock; deleteIfEquals: jest.Mock };
  let cron: CallSweeperCron;
  let queries: any[];

  beforeAll(() => {
    ENV.init({ get: (_k: string, fallback: unknown) => fallback } as any);
  });

  beforeEach(() => {
    ringing = [];
    active = [];
    queries = [];
    callModel = {
      find: jest.fn((filter: any) => {
        queries.push(filter);
        const rows = filter.status === CallStatus.Ringing ? ringing : active;
        return { select: () => ({ lean: async () => rows }) };
      }),
    };
    callService = {
      expireRingingCall: jest.fn().mockResolvedValue(true),
      applyTransition: jest.fn().mockResolvedValue({ changed: true }),
    };
    streamVideo = { endCall: jest.fn().mockResolvedValue(undefined) };
    redis = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      deleteIfEquals: jest.fn().mockResolvedValue(true),
    };
    cron = new CallSweeperCron(
      callModel as any,
      callService as any,
      streamVideo as any,
      redis as any,
    );
    jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('only looks at ringing calls older than timeout + 60s grace', async () => {
    const before = Date.now();
    await cron.sweep();

    const cutoff = queries.find((q) => q.status === CallStatus.Ringing).ringStartedAt.$lt;
    const ageMs = before - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual((45 + 60) * 1000 - 50);
    expect(ageMs).toBeLessThan((45 + 60) * 1000 + 1000);
  });

  it('3. stuck ringing calls → expired as missed', async () => {
    ringing = [{ _id: new Types.ObjectId() }, { _id: new Types.ObjectId() }];

    const res = await cron.sweep();

    expect(res).toEqual({ missed: 2, ended: 0, ran: true });
    expect(callService.expireRingingCall).toHaveBeenCalledTimes(2);
  });

  it('a ringing call answered meanwhile is not counted', async () => {
    ringing = [{ _id: new Types.ObjectId() }];
    callService.expireRingingCall.mockResolvedValue(false);

    expect((await cron.sweep()).missed).toBe(0);
  });

  it('4. active calls answered over 6h ago → ended (network_failure), duration capped, Stream ended', async () => {
    const c = { _id: new Types.ObjectId(), streamCallId: 'default:x' };
    active = [c];

    const res = await cron.sweep();

    expect(res.ended).toBe(1);
    expect(callService.applyTransition).toHaveBeenCalledWith(c._id, CallStatus.Ended, {
      actorId: null,
      reason: CallEndReason.NetworkFailure,
      maxDurationSeconds: SWEEP_ACTIVE_MAX_SECONDS,
    });
    expect(streamVideo.endCall).toHaveBeenCalledWith('default:x');
    const cutoff = queries.find((q) => q.status === CallStatus.Active).answeredAt.$lt;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(SWEEP_ACTIVE_MAX_SECONDS * 1000 - 50);
  });

  it('logs a warning with counts whenever it catches anything, and stays quiet otherwise', async () => {
    const warn = (cron as any).logger.warn as jest.Mock;

    await cron.sweep();
    expect(warn).not.toHaveBeenCalled();

    ringing = [{ _id: new Types.ObjectId() }];
    await cron.sweep();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 stuck ringing'));
  });

  it('5. another replica holds the lock → this one does nothing', async () => {
    redis.setIfAbsent.mockResolvedValue(false);
    ringing = [{ _id: new Types.ObjectId() }];

    expect(await cron.sweep()).toEqual({ missed: 0, ended: 0, ran: false });
    expect(callModel.find).not.toHaveBeenCalled();
  });

  it('releases the lock it took, with its own token', async () => {
    await cron.sweep();

    const [key, , token] = redis.setIfAbsent.mock.calls[0];
    expect(redis.deleteIfEquals).toHaveBeenCalledWith(key, token);
  });

  it('6. Redis down → still sweeps (that is when timeout jobs go missing)', async () => {
    redis.setIfAbsent.mockRejectedValue(new Error('ECONNREFUSED'));
    ringing = [{ _id: new Types.ObjectId() }];

    expect(await cron.sweep()).toEqual({ missed: 1, ended: 0, ran: true });
    expect(redis.deleteIfEquals).not.toHaveBeenCalled();
  });

  it('never overlaps itself within one process', async () => {
    let release!: () => void;
    callModel.find.mockImplementationOnce(() => ({
      select: () => ({ lean: () => new Promise((r) => (release = () => r([]))) }),
    }));

    const first = cron.sweep();
    await new Promise((r) => setImmediate(r));
    expect(await cron.sweep()).toEqual({ missed: 0, ended: 0, ran: false });
    release();
    await first;
  });

  it('a failure is logged, never thrown out of the cron', async () => {
    callModel.find.mockImplementation(() => {
      throw new Error('Mongo down');
    });
    jest.spyOn((cron as any).logger, 'error').mockImplementation(() => undefined);

    await expect(cron.sweep()).resolves.toMatchObject({ ran: true });
    // and the in-process guard is released
    callModel.find.mockImplementation(() => ({ select: () => ({ lean: async () => [] }) }));
    expect((await cron.sweep()).ran).toBe(true);
  });
});
