import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
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
  // Per-test ENV overrides; everything else falls back to its default.
  const env: Record<string, string> = {};
  beforeAll(() => {
    ENV.init({ get: (key: string, fallback: unknown) => env[key] ?? fallback } as any);
  });
  afterEach(() => {
    for (const k of Object.keys(env)) delete env[k];
  });

  let streamVideo: any;
  let callAuthorization: any;
  let callModel: any;
  let userModel: any;
  let conversationModel: any;
  let redis: FakeRedis;
  let queue: any;
  let callAbuse: any;
  let liveCalls: { participants: Types.ObjectId[] }[];
  let service: CallService;

  beforeEach(() => {
    liveCalls = [];
    queue = { add: jest.fn().mockResolvedValue({}), getJob: jest.fn().mockResolvedValue(null) };
    callAbuse = {
      assertWithinRateLimit: jest.fn().mockResolvedValue(undefined),
      assertNotBackedOff: jest.fn().mockResolvedValue(undefined),
      recordInitiation: jest.fn().mockResolvedValue(undefined),
    };
    streamVideo = {
      getClient: jest.fn(),
      getApiKey: jest.fn().mockReturnValue('public-key'),
      upsertUser: jest.fn().mockResolvedValue(undefined),
      upsertUsers: jest.fn().mockResolvedValue(undefined),
      generateUserToken: jest.fn().mockReturnValue('signed-token'),
      createRingingCall: jest.fn().mockResolvedValue(undefined),
      endCall: jest.fn().mockResolvedValue(undefined),
      setOnlyPushDevices: jest.fn().mockResolvedValue(0),
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
    // Callees are calling-capable unless a test says otherwise.
    userModel = {
      findById: jest.fn((id: string) => ({
        select: () => ({
          lean: async () =>
            makeUser({ _id: new Types.ObjectId(id), username: 'bob', callingCapableAt: new Date() }),
        }),
      })),
      updateOne: jest.fn().mockResolvedValue({}),
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
      callAbuse,
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
        apnProviderName: 'boostra-voip-prod',
        firebaseProviderName: 'boostra-android',
      });
    });

    it('serves the sandbox APNs provider to development builds', async () => {
      const res = await service.issueToken(makeUser(), ApnsEnvironment.Development);

      expect(res.push).toMatchObject({
        apnsEnvironment: ApnsEnvironment.Development,
        apnProviderName: 'boostra-voip-dev',
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

  describe('one calling device per user', () => {
    const tokens = [{ token: 'fcm-token-abc', provider: 'firebase' as const }];

    it('claim records the device and makes its push tokens the only ones on Stream', async () => {
      const user = makeUser();

      const res = await service.claimDevice(user, 'device-B', { pushTokens: tokens });

      expect(res.callingDeviceId).toBe('device-B');
      expect(userModel.updateOne).toHaveBeenCalledWith(
        { _id: user._id },
        expect.objectContaining({ callingDeviceId: 'device-B', callingDeviceClaimedAt: expect.any(Date) }),
      );
      expect(streamVideo.setOnlyPushDevices).toHaveBeenCalledWith(user._id.toString(), [
        { id: 'fcm-token-abc', provider: 'firebase', providerName: expect.any(String), voip: false },
      ]);
    });

    it('an iOS VoIP token uses the APNs provider for the build environment', async () => {
      const user = makeUser();

      await service.claimDevice(user, 'device-B', {
        apnsEnvironment: ApnsEnvironment.Development,
        pushTokens: [{ token: 'voip-token-xyz', provider: 'apn', voip: true }],
      });

      expect(streamVideo.setOnlyPushDevices.mock.calls[0][1]).toEqual([
        { id: 'voip-token-xyz', provider: 'apn', providerName: ENV.STREAM_APN_PROVIDER_SANDBOX, voip: true },
      ]);
    });

    it('claim needs the X-Device-Id header', async () => {
      const err = await service.claimDevice(makeUser(), undefined, { pushTokens: tokens }).catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe(CallErrorCode.DeviceIdRequired);
      expect(userModel.updateOne).not.toHaveBeenCalled();
    });

    it('a Stream failure does not undo the claim', async () => {
      streamVideo.setOnlyPushDevices.mockRejectedValue(new Error('Stream down'));

      const res = await service.claimDevice(makeUser(), 'device-B', { pushTokens: tokens });

      expect(res).toEqual({ callingDeviceId: 'device-B', pushDevicesRemoved: null });
      expect(userModel.updateOne).toHaveBeenCalled();
    });

    it('calling from another of the same user\'s devices → 409 CALLING_ON_OTHER_DEVICE, nothing rings', async () => {
      const caller = makeUser({ callingDeviceId: 'device-A' });

      const err = await service
        .initiate(caller, { calleeId: oid().toString(), callType: CallType.Audio }, 'device-B')
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(CallErrorCode.CallingOnOtherDevice);
      expect(callModel.create).not.toHaveBeenCalled();
      expect(streamVideo.createRingingCall).not.toHaveBeenCalled();
    });

    it.each([
      ['from the calling device', 'device-A', 'device-A'],
      ['with no calling device claimed yet', undefined, 'device-B'],
      ['from an older build that sends no device id', 'device-A', undefined],
    ])('calling is allowed %s', async (_label, claimed, sent) => {
      const caller = makeUser({ callingDeviceId: claimed });

      await expect(
        service.initiate(caller, { calleeId: oid().toString(), callType: CallType.Audio }, sent),
      ).resolves.toMatchObject({ callType: CallType.Audio });
    });

    it("the ring names the callee's calling device, so their other devices ignore it", async () => {
      userModel.findById.mockImplementation((id: string) => ({
        select: () => ({
          lean: async () =>
            makeUser({ _id: new Types.ObjectId(id), username: 'bob', callingCapableAt: new Date(), callingDeviceId: 'bobs-phone' }),
        }),
      }));

      await service.initiate(makeUser(), { calleeId: oid().toString(), callType: CallType.Audio });

      expect(streamVideo.createRingingCall.mock.calls[0][0].custom.ringDeviceId).toBe('bobs-phone');
    });

    it('no ring target when the callee has not claimed a device (every device rings, as before)', async () => {
      await service.initiate(makeUser(), { calleeId: oid().toString(), callType: CallType.Audio });

      expect(streamVideo.createRingingCall.mock.calls[0][0].custom).not.toHaveProperty('ringDeviceId');
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

    it('a timed-out creation ends the call on Stream, so a ring that got through stops', async () => {
      streamVideo.createRingingCall.mockRejectedValue(new Error('The request was aborted due to the 5000ms timeout'));

      await expect(
        service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio }),
      ).rejects.toBeInstanceOf(BadGatewayException);

      const [created] = callModel.create.mock.calls[0];
      expect(streamVideo.endCall).toHaveBeenCalledWith(created.streamCallId);
    });

    it('still reports the failure when Stream cannot be told to end it', async () => {
      streamVideo.createRingingCall.mockRejectedValue(new Error('timeout'));
      streamVideo.endCall.mockRejectedValue(new Error('Stream down'));

      await expect(
        service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio }),
      ).rejects.toBeInstanceOf(BadGatewayException);
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
      streamCallId: 'default:abc-123',
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

    it('returns the Stream call split into type and id (crash-rejoin lookup)', async () => {
      rows = [row(), row({ streamCallId: undefined }), row({ streamCallId: 'garbage' })];

      const { data } = await service.getHistory(me, { page: 1, limit: 10 } as any);

      expect(data.map((d) => d.stream)).toEqual([{ type: 'default', id: 'abc-123' }, null, null]);
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

  describe('abuse controls in initiate (Iteration 11)', () => {
    const calleeId = () => oid().toString();

    it('checks the rate limit and the backoff after authorization, before anything is created', async () => {
      const order: string[] = [];
      callAuthorization.assertCanCall.mockImplementation(async () => order.push('authz'));
      callAbuse.assertWithinRateLimit.mockImplementation(async () => order.push('rate'));
      callAbuse.assertNotBackedOff.mockImplementation(async () => order.push('backoff'));
      callModel.create.mockImplementation(async (doc: any) => {
        order.push('create');
        return { ...doc, _id: oid(), createdAt: new Date() };
      });

      await service.initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio });

      expect(order).toEqual(['authz', 'rate', 'backoff', 'create']);
    });

    it('a rate-limited caller creates nothing', async () => {
      callAbuse.assertWithinRateLimit.mockRejectedValue(new HttpException({ code: 'CALL_RATE_LIMITED' }, 429));

      const err = await service
        .initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio })
        .catch((e) => e);

      expect(err.getStatus()).toBe(429);
      expect(callModel.create).not.toHaveBeenCalled();
    });

    it('counts only calls that actually started ringing', async () => {
      const caller = makeUser();
      await service.initiate(caller, { calleeId: calleeId(), callType: CallType.Audio });
      expect(callAbuse.recordInitiation).toHaveBeenCalledWith(caller._id.toString());

      callAbuse.recordInitiation.mockClear();
      streamVideo.createRingingCall.mockRejectedValue(new Error('boom'));
      await service
        .initiate(makeUser(), { calleeId: calleeId(), callType: CallType.Audio })
        .catch(() => undefined);
      expect(callAbuse.recordInitiation).not.toHaveBeenCalled();
    });
  });

  describe('recordStats (Iteration 11)', () => {
    let me: any;
    let call: any;

    beforeEach(() => {
      me = makeUser();
      call = { _id: oid(), participants: [me._id, oid()] };
      callModel.findById = jest.fn(() => ({ lean: async () => call }));
    });

    it('stores the reporter\'s stats under metadata.quality.<userId>', async () => {
      await service.recordStats(me, String(call._id), { mos: 4.2, packetLoss: 1.5, jitter: 30, reconnectCount: 1 });

      const [filter, update] = callModel.updateOne.mock.calls[0];
      expect(filter).toEqual({ _id: call._id });
      expect(update.$set[`metadata.quality.${me._id}`]).toMatchObject({
        mos: 4.2,
        packetLoss: 1.5,
        jitter: 30,
        reconnectCount: 1,
        reportedAt: expect.any(Date),
      });
    });

    it('only stores fields that were sent', async () => {
      await service.recordStats(me, String(call._id), { mos: 3 });

      const stored = callModel.updateOne.mock.calls[0][1].$set[`metadata.quality.${me._id}`];
      expect(Object.keys(stored).sort()).toEqual(['mos', 'reportedAt']);
    });

    it('a non-participant gets 403', async () => {
      const err = await service.recordStats(makeUser(), String(call._id), { mos: 3 }).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(callModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('Iteration 12', () => {
    const noCapability = () =>
      userModel.findById.mockImplementation((id: string) => ({
        select: () => ({ lean: async () => makeUser({ _id: new Types.ObjectId(id) }) }),
      }));

    describe('calling capability', () => {
      it('1. a callee who never fetched a token → 409 CALLEE_UNSUPPORTED; nothing written, nothing rung', async () => {
        noCapability();

        const err = await service
          .initiate(makeUser(), { calleeId: oid().toString(), callType: CallType.Audio })
          .catch((e) => e);

        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse().code).toBe('CALLEE_UNSUPPORTED');
        expect(callModel.create).not.toHaveBeenCalled();
        expect(streamVideo.createRingingCall).not.toHaveBeenCalled();
      });

      it('2. fetching a token stamps callingCapableAt with a conditional write', async () => {
        const user = makeUser();

        await service.issueToken(user);

        const [filter, update] = userModel.updateOne.mock.calls[0];
        expect(filter._id).toBe(user._id);
        expect(filter.$or).toBeDefined(); // only when missing or stale
        expect(update.$set.callingCapableAt).toBeInstanceOf(Date);
      });

      it('2b. repeat token fetches within 24h write nothing', async () => {
        await service.issueToken(makeUser({ callingCapableAt: new Date(Date.now() - 3600_000) }));

        expect(userModel.updateOne).not.toHaveBeenCalled();
      });

      it('a failed stamp never fails token issuance', async () => {
        userModel.updateOne.mockRejectedValue(new Error('Mongo down'));

        await expect(service.issueToken(makeUser())).resolves.toMatchObject({ token: 'signed-token' });
      });
    });

    describe('canCall', () => {
      it('allowed when every check passes', async () => {
        await expect(service.canCall(makeUser(), oid().toString())).resolves.toEqual({ allowed: true });
        expect(callModel.create).not.toHaveBeenCalled();
      });

      it('returns the refusal code instead of throwing', async () => {
        callAuthorization.assertCanCall.mockRejectedValue(
          new CallForbiddenException(CallErrorCode.UserUnavailable, 'x', CallDenialReason.Blocked),
        );

        await expect(service.canCall(makeUser(), oid().toString())).resolves.toEqual({
          allowed: false,
          code: CallErrorCode.UserUnavailable,
        });
      });

      it('reports CALLEE_UNSUPPORTED and CALLEE_BUSY like initiate would', async () => {
        noCapability();
        expect((await service.canCall(makeUser(), oid().toString())).code).toBe('CALLEE_UNSUPPORTED');

        userModel.findById.mockImplementation((id: string) => ({
          select: () => ({ lean: async () => makeUser({ _id: new Types.ObjectId(id), callingCapableAt: new Date() }) }),
        }));
        const callee = oid().toString();
        liveCalls = [{ participants: [oid(), new Types.ObjectId(callee)] }];
        expect((await service.canCall(makeUser(), callee)).code).toBe(CallErrorCode.CalleeBusy);
      });

      it('an unexpected error still throws (no silent "allowed: false")', async () => {
        callAuthorization.assertCanCall.mockRejectedValue(new Error('Mongo down'));

        await expect(service.canCall(makeUser(), oid().toString())).rejects.toThrow('Mongo down');
      });
    });

    describe('history management', () => {
      let me: any;
      let call: any;

      beforeEach(() => {
        me = makeUser();
        call = { _id: oid(), initiator: me._id, participants: [me._id, oid()] };
        callModel.findById = jest.fn(() => ({ lean: async () => call }));
        callModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 4 });
      });

      it('6. hiding adds only the requester to hiddenFor', async () => {
        await service.hideCall(me, String(call._id));

        expect(callModel.updateOne).toHaveBeenCalledWith(
          { _id: call._id },
          { $addToSet: { hiddenFor: expect.any(Types.ObjectId) } },
        );
        expect(String(callModel.updateOne.mock.calls[0][1].$addToSet.hiddenFor)).toBe(me._id.toString());
      });

      it('a non-participant cannot hide a call', async () => {
        await expect(service.hideCall(makeUser(), String(call._id))).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('clearing history marks every visible call of mine as hidden', async () => {
        await expect(service.clearHistory(me)).resolves.toEqual({ hidden: 4 });

        const [filter, update] = callModel.updateMany.mock.calls[0];
        expect(String(filter.participants)).toBe(me._id.toString());
        expect(String(filter.hiddenFor.$ne)).toBe(me._id.toString());
        expect(String(update.$addToSet.hiddenFor)).toBe(me._id.toString());
      });
    });

    describe('missed-call badge', () => {
      it('7. counts missed calls to me, not by me, not hidden, since callsSeenAt', async () => {
        const me = makeUser();
        const seenAt = new Date(Date.now() - 3600_000);
        userModel.findById.mockImplementation(() => ({
          select: () => ({ lean: async () => ({ callsSeenAt: seenAt }) }),
        }));
        callModel.countDocuments = jest.fn(async () => 2);

        await expect(service.getUnseenCount(me)).resolves.toEqual({ count: 2 });

        const filter = callModel.countDocuments.mock.calls[0][0];
        expect(filter.status).toBe(CallStatus.Missed);
        expect(String(filter.initiator.$ne)).toBe(me._id.toString());
        expect(String(filter.hiddenFor.$ne)).toBe(me._id.toString());
        expect(filter.createdAt.$gt).toBe(seenAt);
      });

      it('marking seen stamps callsSeenAt', async () => {
        const me = makeUser();

        await service.markSeen(me);

        expect(userModel.updateOne).toHaveBeenCalledWith(
          { _id: me._id },
          { $set: { callsSeenAt: expect.any(Date) } },
        );
      });
    });

    describe('call reports', () => {
      it('8. the reported user is the other participant', async () => {
        const me = makeUser();
        const other = oid();
        callModel.findById = jest.fn(() => ({ lean: async () => ({ _id: oid(), initiator: other, participants: [other, me._id] }) }));

        const target = await service.resolveReportTarget(oid().toString(), me._id.toString());

        expect(String(target)).toBe(String(other));
      });

      it('8b. a non-participant cannot report the call', async () => {
        callModel.findById = jest.fn(() => ({ lean: async () => ({ _id: oid(), participants: [oid(), oid()] }) }));

        await expect(
          service.resolveReportTarget(oid().toString(), oid().toString()),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    describe('post-call feedback', () => {
      it('stores rating and de-duplicated issues under metadata.feedback.<userId>', async () => {
        const me = makeUser();
        callModel.findById = jest.fn(() => ({ lean: async () => ({ _id: oid(), participants: [me._id, oid()] }) }));

        await service.recordStats(me, oid().toString(), { rating: 2, issues: ['audio', 'audio', 'echo'] as any });

        const set = callModel.updateOne.mock.calls[0][1].$set;
        expect(set[`metadata.feedback.${me._id}`]).toEqual({
          rating: 2,
          issues: ['audio', 'echo'],
          ratedAt: expect.any(Date),
        });
        // Rating only: the quality stats sent at hang-up are left alone.
        expect(set).not.toHaveProperty(`metadata.quality.${me._id}`);
      });

      it('an empty report writes nothing', async () => {
        const me = makeUser();
        callModel.findById = jest.fn(() => ({ lean: async () => ({ _id: oid(), participants: [me._id, oid()] }) }));
        callModel.updateOne.mockClear();

        await expect(service.recordStats(me, oid().toString(), {})).resolves.toEqual({ recorded: true });

        expect(callModel.updateOne).not.toHaveBeenCalled();
      });
    });

    it('settings: default is mutual_follows, and updates are saved', async () => {
      userModel.findById.mockImplementation(() => ({ select: () => ({ lean: async () => ({}) }) }));
      await expect(service.getSettings(makeUser())).resolves.toEqual({ callPrivacy: 'mutual_follows' });

      const me = makeUser();
      await service.updateSettings(me, 'nobody' as any);
      expect(userModel.updateOne).toHaveBeenCalledWith({ _id: me._id }, { $set: { callPrivacy: 'nobody' } });
    });

    it('history excludes calls I hid', async () => {
      const me = makeUser();
      let filter: any;
      const chain: any = { sort: () => chain, skip: () => chain, limit: () => chain, populate: () => chain, lean: async () => [] };
      callModel.find = jest.fn((f: any) => ((filter = f), chain));
      callModel.countDocuments = jest.fn(async () => 0);

      await service.getHistory(me, { page: 1, limit: 10 } as any);

      expect(String(filter.hiddenFor.$ne)).toBe(me._id.toString());
    });
  });

  describe('CALLING_ENABLED feature flag (Iteration 13)', () => {
    const disabled = async (p: Promise<unknown>) => {
      const err = await p.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse().code).toBe('CALLING_DISABLED');
    };

    it('1. off: token, initiate and pre-flight all return 503 CALLING_DISABLED', async () => {
      env.CALLING_ENABLED = 'false';

      await disabled(service.issueToken(makeUser()));
      await disabled(service.initiate(makeUser(), { calleeId: oid().toString(), callType: CallType.Audio }));
      await disabled(service.canCall(makeUser(), oid().toString()));
      expect(callModel.create).not.toHaveBeenCalled();
    });

    it('off: users on the rollout allow-list still can', async () => {
      const insider = makeUser();
      env.CALLING_ENABLED = 'false';
      env.CALLING_ROLLOUT_USER_IDS = `${oid()}, ${insider._id}`;

      await expect(service.issueToken(insider)).resolves.toMatchObject({ token: 'signed-token' });
      await disabled(service.issueToken(makeUser()));
    });

    it('defaults OFF in production and ON elsewhere', async () => {
      env.NODE_ENV = 'production';
      await disabled(service.issueToken(makeUser()));

      env.NODE_ENV = 'development';
      await expect(service.issueToken(makeUser())).resolves.toBeDefined();
    });

    it('an explicit true in production turns it on', async () => {
      env.NODE_ENV = 'production';
      env.CALLING_ENABLED = 'true';

      await expect(service.issueToken(makeUser())).resolves.toBeDefined();
    });
  });
});
