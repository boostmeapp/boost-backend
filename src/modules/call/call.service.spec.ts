import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { CallService } from './call.service';
import { CallForbiddenException } from './call-authorization.service';
import { ENV } from '../../config';
import {
  ApnsEnvironment,
  CallDenialReason,
  CallEndReason,
  CallErrorCode,
  CallStatus,
  CallType,
  STREAM_TOKEN_VALIDITY_SECONDS,
} from './call.constants';

const oid = () => new Types.ObjectId();

const makeUser = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: oid(),
    username: 'alexandra',
    profileImage: 'https://cdn.example.com/a.jpg',
    isActive: true,
    isBanned: false,
    ...overrides,
  }) as any;

/** In-memory stand-in for the Redis lock primitives. */
class FakeRedis {
  store = new Map<string, string>();
  fail = false;
  async setIfAbsent(key: string, _ttl: number, value = '1') {
    if (this.fail) throw new Error('ECONNREFUSED');
    if (this.store.has(key)) return false;
    this.store.set(key, value);
    return true;
  }
  async deleteIfEquals(key: string, value: string) {
    if (this.store.get(key) !== value) return false;
    this.store.delete(key);
    return true;
  }
}

describe('CallService', () => {
  beforeAll(() => {
    // Built-in defaults for every ENV getter.
    ENV.init({ get: (_key: string, fallback: unknown) => fallback } as any);
  });

  let streamVideo: any;
  let callAuthorization: any;
  let callModel: any;
  let userModel: any;
  let conversationModel: any;
  let redis: FakeRedis;
  let queue: any;
  let liveCalls: { participants: Types.ObjectId[] }[];
  let service: CallService;

  beforeEach(() => {
    liveCalls = [];
    queue = { add: jest.fn().mockResolvedValue({}), getJob: jest.fn().mockResolvedValue(null) };
    streamVideo = {
      getClient: jest.fn(),
      getApiKey: jest.fn().mockReturnValue('public-key'),
      upsertUser: jest.fn().mockResolvedValue(undefined),
      upsertUsers: jest.fn().mockResolvedValue(undefined),
      generateUserToken: jest.fn().mockReturnValue('signed-token'),
      createRingingCall: jest.fn().mockResolvedValue(undefined),
    };
    callAuthorization = { assertCanCall: jest.fn().mockResolvedValue(undefined) };
    callModel = {
      find: jest.fn(() => ({ select: () => ({ lean: async () => liveCalls }) })),
      create: jest.fn(async (doc: any) => {
        // A created call is live for subsequent busy checks.
        liveCalls.push({ participants: doc.participants });
        return { ...doc, _id: oid(), createdAt: new Date() };
      }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    userModel = {
      findById: jest.fn((id: string) => ({
        select: () => ({ lean: async () => makeUser({ _id: new Types.ObjectId(id), username: 'bob' }) }),
      })),
    };
    conversationModel = { exists: jest.fn().mockResolvedValue({ _id: oid() }) };
    redis = new FakeRedis();
    service = new CallService(
      callModel,
      userModel,
      conversationModel,
      streamVideo,
      callAuthorization,
      redis as any,
      queue,
      { onCallTerminated: jest.fn() } as any,
    );
  });

  describe('issueToken', () => {
    it('returns apiKey, token, userId, and a ~24h expiry', async () => {
      const user = makeUser();
      const before = Date.now();

      const res = await service.issueToken(user);

      expect(res).toMatchObject({
        apiKey: 'public-key',
        token: 'signed-token',
        userId: user._id.toString(),
      });
      const expiresIn = Date.parse(res.expiresAt) - before;
      expect(Math.abs(expiresIn - STREAM_TOKEN_VALIDITY_SECONDS * 1000)).toBeLessThan(5_000);
    });

    it('defaults to the production APNs provider (store / TestFlight / staging builds)', async () => {
      const res = await service.issueToken(makeUser());

      expect(res.push).toEqual({
        apnsEnvironment: ApnsEnvironment.Production,
        apnProviderName: 'boostra-voip-production',
        firebaseProviderName: 'boostra-android',
      });
    });

    it('serves the sandbox APNs provider to development builds', async () => {
      const res = await service.issueToken(makeUser(), ApnsEnvironment.Development);

      expect(res.push).toMatchObject({
        apnsEnvironment: ApnsEnvironment.Development,
        apnProviderName: 'boostra-voip-sandbox',
      });
    });

    it('upserts the Mongo id, display name, and avatar to Stream', async () => {
      const user = makeUser();

      await service.issueToken(user);

      expect(streamVideo.upsertUser).toHaveBeenCalledWith({
        id: user._id.toString(),
        name: 'alexandra',
        image: 'https://cdn.example.com/a.jpg',
      });
    });

    it('falls back to a generic name and omits a missing avatar', async () => {
      await service.issueToken(makeUser({ username: '  ', profileImage: undefined }));

      expect(streamVideo.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Boostra user', image: undefined }),
      );
    });

    it('still returns a token when the Stream upsert fails', async () => {
      streamVideo.upsertUser.mockRejectedValue(new Error('Stream down'));

      await expect(service.issueToken(makeUser())).resolves.toMatchObject({
        token: 'signed-token',
      });
    });

    it('rejects banned users with ACCOUNT_BANNED and issues nothing', async () => {
      const err = await service.issueToken(makeUser({ isBanned: true })).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse().code).toBe(CallErrorCode.AccountBanned);
      expect(streamVideo.generateUserToken).not.toHaveBeenCalled();
    });

    it('surfaces 503 when calling is disabled', async () => {
      streamVideo.getApiKey.mockImplementation(() => {
        throw new ServiceUnavailableException();
      });

      await expect(service.issueToken(makeUser())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('initiate', () => {
    const calleeId = () => oid().toString();

    it('persists a ringing call, rings on Stream, and returns callee display data', async () => {
      const caller = makeUser();
      const callee = calleeId();

      const res = await service.initiate(caller, { calleeId: callee, callType: CallType.Video });

      const created = callModel.create.mock.calls[0][0];
      expect(created).toMatchObject({ callType: CallType.Video, status: CallStatus.Ringing });
      expect(created.participants.map(String)).toEqual([caller._id.toString(), callee]);
      expect(created.ringStartedAt).toBeInstanceOf(Date);

      expect(res.streamCallId).toMatch(
        /^default:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(res.streamCallId).toBe(`${res.stream.type}:${res.stream.id}`);
      expect(res.streamCallId).not.toContain(callee);
      expect(res.callee).toMatchObject({ id: callee, name: 'bob' });

      expect(streamVideo.createRingingCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'default',
          id: res.stream.id,
          callerId: caller._id.toString(),
          calleeId: callee,
          video: true,
          custom: expect.objectContaining({ callId: res.callId, callType: CallType.Video }),
        }),
      );
    });

    it('schedules the ring timeout, keyed by call id, delayed by CALL_RING_TIMEOUT_SECONDS', async () => {
      const res = await service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio });

      expect(queue.add).toHaveBeenCalledWith(
        'ring-timeout',
        { callId: res.callId },
        expect.objectContaining({ jobId: res.callId, delay: 45_000 }),
      );
    });

    it('still returns the call when the timeout cannot be enqueued (the sweeper covers it)', async () => {
      queue.add.mockRejectedValue(new Error('Redis down'));

      await expect(
        service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio }),
      ).resolves.toMatchObject({ callType: CallType.Audio });
    });

    it('does not schedule a timeout when Stream creation fails', async () => {
      streamVideo.createRingingCall.mockRejectedValue(new Error('boom'));

      await service
        .initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio })
        .catch(() => undefined);

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('persists before calling Stream', async () => {
      const order: string[] = [];
      callModel.create.mockImplementation(async (doc: any) => {
        order.push('db');
        return { ...doc, _id: oid(), createdAt: new Date() };
      });
      streamVideo.createRingingCall.mockImplementation(async () => {
        order.push('stream');
      });

      await service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio });

      expect(order).toEqual(['db', 'stream']);
    });

    it('creates nothing when authorization fails', async () => {
      callAuthorization.assertCanCall.mockRejectedValue(
        new CallForbiddenException(CallErrorCode.UserUnavailable, 'x', CallDenialReason.Blocked),
      );

      await expect(
        service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(callModel.create).not.toHaveBeenCalled();
      expect(streamVideo.createRingingCall).not.toHaveBeenCalled();
    });

    it('returns 409 CALLEE_BUSY when the callee is already in a call', async () => {
      const callee = calleeId();
      liveCalls = [{ participants: [oid(), new Types.ObjectId(callee)] }];

      const err = await service
        .initiate(makeUser(), { calleeId: callee, callType: CallType.Audio })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(CallErrorCode.CalleeBusy);
      expect(callModel.create).not.toHaveBeenCalled();
    });

    it('returns 409 ALREADY_IN_CALL when the caller is already in a call', async () => {
      const caller = makeUser();
      liveCalls = [{ participants: [caller._id, oid()] }];

      const err = await service
        .initiate(caller, { calleeId: calleeId(), callType: CallType.Audio })
        .catch((e) => e);

      expect(err.getResponse().code).toBe(CallErrorCode.AlreadyInCall);
    });

    it('immediately repeating the same call returns 409, never a double ring', async () => {
      const caller = makeUser();
      const callee = calleeId();

      await service.initiate(caller, { calleeId: callee, callType: CallType.Audio });
      const err = await service
        .initiate(caller, { calleeId: callee, callType: CallType.Audio })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(streamVideo.createRingingCall).toHaveBeenCalledTimes(1);
    });

    it('two concurrent initiations to the same callee: exactly one succeeds', async () => {
      const callee = calleeId();
      // Hold the first request inside the lock so the second genuinely overlaps.
      let releaseFirst!: () => void;
      const firstInside = new Promise<void>((r) => (releaseFirst = r));
      const realFind = callModel.find;
      let calls = 0;
      callModel.find = jest.fn((...args: any[]) => {
        calls += 1;
        if (calls === 1) {
          return { select: () => ({ lean: () => firstInside.then(() => liveCalls) }) };
        }
        return realFind(...args);
      });

      const a = service.initiate(makeUser(), { calleeId: callee, callType: CallType.Audio });
      const b = service.initiate(makeUser(), { calleeId: callee, callType: CallType.Audio });
      const bResult = await b.catch((e) => e);
      releaseFirst();
      const aResult = await a;

      expect(aResult.callId).toBeDefined();
      expect(bResult).toBeInstanceOf(ConflictException);
      expect(bResult.getResponse().code).toBe(CallErrorCode.CalleeBusy);
      expect(callModel.create).toHaveBeenCalledTimes(1);
    });

    it('releases its locks afterwards, including on failure', async () => {
      liveCalls = [{ participants: [oid(), oid()] }];
      await service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio });

      streamVideo.createRingingCall.mockRejectedValue(new Error('boom'));
      await service
        .initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio })
        .catch(() => undefined);

      expect(redis.store.size).toBe(0);
    });

    it('fails closed with 503 when Redis is unavailable', async () => {
      redis.fail = true;

      await expect(
        service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(callModel.create).not.toHaveBeenCalled();
    });

    it('marks the record failed and returns 502 when Stream fails', async () => {
      streamVideo.createRingingCall.mockRejectedValue(new Error('Stream 500'));

      const err = await service
        .initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio })
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadGatewayException);
      expect(err.getResponse().code).toBe(CallErrorCode.CallFailed);
      expect(callModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ status: CallStatus.Ringing }),
        expect.objectContaining({
          status: CallStatus.Failed,
          endedReason: CallEndReason.NetworkFailure,
        }),
      );
    });

    it('rejects a conversation the two users do not share', async () => {
      conversationModel.exists.mockResolvedValue(null);

      await expect(
        service.initiate(makeUser(), {
          calleeId: calleeId(),
          callType: CallType.Audio,
          conversationId: oid().toString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(callModel.create).not.toHaveBeenCalled();
    });

    it('attaches a valid conversation to the record and Stream custom data', async () => {
      const conversationId = oid().toString();

      await service.initiate(makeUser(), {
        calleeId: calleeId(),
        callType: CallType.Audio,
        conversationId,
      });

      expect(String(callModel.create.mock.calls[0][0].conversation)).toBe(conversationId);
      expect(streamVideo.createRingingCall.mock.calls[0][0].custom.conversationId).toBe(
        conversationId,
      );
    });
  });
  describe('getHistory', () => {
    let me: any;
    let other: any;
    let lastFilter: any;
    let lastSkip: number;
    let rows: any[];

    beforeEach(() => {
      me = makeUser();
      other = { _id: oid(), username: 'bob', profileImage: 'https://cdn/b.jpg' };
      rows = [];
      const chain: any = {
        sort: () => chain,
        skip: (n: number) => ((lastSkip = n), chain),
        limit: () => chain,
        populate: () => chain,
        lean: async () => rows,
      };
      callModel.find = jest.fn((f: any) => ((lastFilter = f), chain));
      callModel.countDocuments = jest.fn(async () => 23);
    });

    const row = (overrides: Record<string, unknown> = {}) => ({
      _id: oid(),
      callType: CallType.Video,
      status: CallStatus.Ended,
      initiator: me._id,
      participants: [{ _id: me._id, username: 'me' }, other],
      ringStartedAt: new Date(),
      answeredAt: new Date(),
      endedAt: new Date(),
      durationSeconds: 252,
      createdAt: new Date(),
      ...overrides,
    });

    it('scopes to the requester, never a user id from the query', async () => {
      await service.getHistory(me, { page: 1, limit: 10 } as any);

      expect(String(lastFilter.participants)).toBe(me._id.toString());
    });

    it('computes direction relative to the requester and returns only the other participant', async () => {
      rows = [row(), row({ initiator: other._id })];

      const { data } = await service.getHistory(me, { page: 1, limit: 10 } as any);

      expect(data.map((d) => d.direction)).toEqual(['outgoing', 'incoming']);
      expect(data[0].otherParticipant).toEqual({
        id: String(other._id),
        name: 'bob',
        image: 'https://cdn/b.jpg',
      });
    });

    it('renders a deleted participant as a placeholder instead of failing', async () => {
      rows = [row({ participants: [{ _id: me._id }, null] })];

      const { data } = await service.getHistory(me, { page: 1, limit: 10 } as any);

      expect(data[0].otherParticipant).toEqual({ id: null, name: 'Deleted user', image: null });
    });

    it('paginates with correct metadata', async () => {
      const res = await service.getHistory(me, { page: 3, limit: 5 } as any);

      expect(lastSkip).toBe(10);
      expect(res.meta).toEqual({ page: 3, limit: 5, total: 23, totalPages: 5 });
    });

    it('filters by conversation and status when given', async () => {
      const conversationId = oid().toString();

      await service.getHistory(me, { page: 1, limit: 10, conversationId, status: CallStatus.Active } as any);

      expect(String(lastFilter.conversation)).toBe(conversationId);
      expect(lastFilter.status).toBe(CallStatus.Active);
    });
  });
});
