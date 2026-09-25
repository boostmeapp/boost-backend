import { Types } from 'mongoose';
import {
  CallAuthorizationService,
  CallForbiddenException,
} from './call-authorization.service';
import { CALL_POLICY, CallDenialReason, CallErrorCode } from './call.constants';

const id = () => new Types.ObjectId().toString();

type TestUser = {
  _id: string;
  isActive?: boolean;
  isBanned?: boolean;
  callingRestricted?: boolean;
};

describe('CallAuthorizationService.assertCanCall', () => {
  let callerId: string;
  let calleeId: string;
  let users: TestUser[];
  let blocked: boolean;
  let followCount: number;
  let service: CallAuthorizationService;

  const userModel = {
    find: jest.fn(() => ({
      select: () => ({ lean: () => Promise.resolve(users) }),
    })),
  };
  const followModel = {
    countDocuments: jest.fn(() => Promise.resolve(followCount)),
  };
  const chatService = {
    isBlockedBetween: jest.fn(() => Promise.resolve(blocked)),
  };

  const denial = (caller = callerId, callee = calleeId) =>
    service.assertCanCall(caller, callee).then(
      () => null,
      (e) => e as CallForbiddenException,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    CALL_POLICY.requireMutualFollow = true;
    callerId = id();
    calleeId = id();
    users = [
      { _id: callerId, isActive: true, isBanned: false, callingRestricted: false },
      { _id: calleeId, isActive: true, isBanned: false, callingRestricted: false },
    ];
    blocked = false;
    followCount = 0;
    service = new CallAuthorizationService(
      userModel as any,
      followModel as any,
      chatService as any,
    );
  });

  it('1. rejects a self-call with CANNOT_CALL_SELF before touching the DB', async () => {
    const err = await denial(callerId, callerId);

    expect(err?.getResponse()).toMatchObject({ code: CallErrorCode.CannotCallSelf });
    expect(err?.reason).toBe(CallDenialReason.Self);
    expect(userModel.find).not.toHaveBeenCalled();
  });

  it('2. rejects a non-existent callee with USER_UNAVAILABLE', async () => {
    users = users.filter((u) => u._id !== calleeId);

    const err = await denial();

    expect(err?.getResponse()).toMatchObject({ code: CallErrorCode.UserUnavailable });
    expect(err?.reason).toBe(CallDenialReason.CalleeUnavailable);
  });

  it.each([
    ['inactive', { isActive: false }],
    ['banned', { isBanned: true }],
  ])('2b. rejects a %s callee with USER_UNAVAILABLE', async (_, patch) => {
    Object.assign(users[1], patch);

    const err = await denial();

    expect(err?.reason).toBe(CallDenialReason.CalleeUnavailable);
  });

  it('3. rejects when the caller blocked the callee', async () => {
    blocked = true;

    const err = await denial();

    expect(err?.reason).toBe(CallDenialReason.Blocked);
    expect(chatService.isBlockedBetween).toHaveBeenCalledWith(callerId, calleeId);
  });

  it('4. a block is externally identical to an unavailable user', async () => {
    blocked = true;
    const blockedErr = await denial();

    blocked = false;
    users = users.filter((u) => u._id !== calleeId);
    const unavailableErr = await denial();

    expect(blockedErr?.getStatus()).toBe(unavailableErr?.getStatus());
    expect(blockedErr?.getResponse()).toEqual(unavailableErr?.getResponse());
    expect(blockedErr?.reason).not.toBe(unavailableErr?.reason);
  });

  it('5. rejects with NOT_CONNECTED when there is no relationship and the policy is on', async () => {
    const err = await denial();

    expect(err?.getResponse()).toMatchObject({ code: CallErrorCode.NotConnected });
  });

  it('6. allows an unconnected call when the policy is off', async () => {
    CALL_POLICY.requireMutualFollow = false;

    await expect(service.assertCanCall(callerId, calleeId)).resolves.toBeUndefined();
    expect(followModel.countDocuments).not.toHaveBeenCalled();
  });

  it('7. allows the call on a mutual follow', async () => {
    followCount = 2;

    await expect(service.assertCanCall(callerId, calleeId)).resolves.toBeUndefined();
    const [query] = (followModel.countDocuments.mock.calls[0] as unknown) as [any];
    expect(query.$or.map((q: any) => `${q.follower}>${q.following}`).sort()).toEqual(
      [`${callerId}>${calleeId}`, `${calleeId}>${callerId}`].sort(),
    );
  });

  it('8. rejects a one-way follow in either direction', async () => {
    followCount = 1;

    expect((await denial())?.reason).toBe(CallDenialReason.NotConnected);
  });

  it.each([
    ['banned', { isBanned: true }],
    ['calling-restricted', { callingRestricted: true }],
  ])('rejects a %s caller with CALLING_RESTRICTED', async (_, patch) => {
    Object.assign(users[0], patch);
    followCount = 2;

    const err = await denial();

    expect(err?.getResponse()).toMatchObject({ code: CallErrorCode.CallingRestricted });
    expect(chatService.isBlockedBetween).not.toHaveBeenCalled();
  });

  it('treats a malformed callee id as unavailable', async () => {
    users = users.filter((u) => u._id !== calleeId);

    const err = await denial(callerId, 'not-an-id');

    expect(err?.getResponse()).toMatchObject({ code: CallErrorCode.UserUnavailable });
  });
});
