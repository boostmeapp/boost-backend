import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CallService } from './call.service';
import {
  CALL_TRANSITIONS,
  CallEndReason,
  CallErrorCode,
  CallStatus,
  CallType,
} from './call.constants';

// Copies arrays but keeps ObjectId instances intact (structuredClone would not).
const clone = (d: any) =>
  d && { ...d, participants: [...d.participants], rejectedBy: [...(d.rejectedBy ?? [])] };

/**
 * In-memory stand-in for the Call model that honours the conditional write
 * `findOneAndUpdate({ _id, status }, ...)` — the thing that makes transitions atomic.
 */
class FakeCallModel {
  docs = new Map<string, any>();
  /** Hook to simulate a concurrent writer between our read and our write. */
  beforeWrite: ((id: string) => void) | null = null;

  insert(doc: Record<string, any>): any {
    const full = { _id: new Types.ObjectId(), rejectedBy: [], ...doc };
    this.docs.set(String(full._id), full);
    return full;
  }

  findById(id: any) {
    const doc = this.docs.get(String(id));
    const query = {
      select: () => query,
      lean: async () => (doc ? clone(doc) : null),
    };
    return query;
  }

  findOneAndUpdate(filter: any, update: any) {
    return {
      lean: async () => {
        const id = String(filter._id);
        this.beforeWrite?.(id);
        const doc = this.docs.get(id);
        if (!doc || doc.status !== filter.status) return null;
        Object.assign(doc, update.$set);
        for (const [k, v] of Object.entries(update.$addToSet ?? {})) {
          if (!doc[k].some((x: any) => String(x) === String(v))) doc[k].push(v);
        }
        return clone(doc);
      },
    };
  }

  find(filter: any) {
    const [a, b] = filter.participants.$all.map(String);
    const results = [...this.docs.values()].filter(
      (d) =>
        d.participants.map(String).includes(a) &&
        d.participants.map(String).includes(b) &&
        filter.status.$in.includes(d.status),
    );
    return { select: () => ({ lean: async () => results.map(clone) }) };
  }
}

describe('Call lifecycle', () => {
  let model: FakeCallModel;
  let streamVideo: { endCall: jest.Mock };
  let queue: { getJob: jest.Mock };
  let job: { remove: jest.Mock };
  let callEvents: { onCallTerminated: jest.Mock };
  let service: CallService;
  let caller: any;
  let callee: any;
  let stranger: any;

  const user = () => ({ _id: new Types.ObjectId() }) as any;
  const newCall = (overrides: Record<string, any> = {}) =>
    model.insert({
      streamCallId: `default:${new Types.ObjectId()}`,
      callType: CallType.Video,
      initiator: caller._id,
      participants: [caller._id, callee._id],
      status: CallStatus.Ringing,
      ringStartedAt: new Date(),
      ...overrides,
    });
  const act = (who: any, call: any, action: any) =>
    service.performAction(who, String(call._id), action);
  const failure = (p: Promise<unknown>) => p.then(() => null, (e) => e);

  beforeEach(() => {
    model = new FakeCallModel();
    streamVideo = { endCall: jest.fn().mockResolvedValue(undefined) };
    callEvents = { onCallTerminated: jest.fn().mockResolvedValue(undefined) };
    job = { remove: jest.fn().mockResolvedValue(undefined) };
    queue = { getJob: jest.fn().mockResolvedValue(job) };
    service = new CallService(
      model as any,
      {} as any,
      {} as any,
      streamVideo as any,
      {} as any,
      {} as any,
      queue as any,
      callEvents as any,
    );
    caller = user();
    callee = user();
    stranger = user();
  });

  it('the transition table has exactly the documented shape', () => {
    expect(CALL_TRANSITIONS[CallStatus.Ringing]).toEqual(
      expect.arrayContaining([
        CallStatus.Active,
        CallStatus.Rejected,
        CallStatus.Cancelled,
        CallStatus.Missed,
        CallStatus.Failed,
      ]),
    );
    expect(CALL_TRANSITIONS[CallStatus.Active]).toEqual([CallStatus.Ended, CallStatus.Failed]);
    for (const s of [
      CallStatus.Ended,
      CallStatus.Rejected,
      CallStatus.Cancelled,
      CallStatus.Missed,
      CallStatus.Failed,
    ]) {
      expect(CALL_TRANSITIONS[s]).toEqual([]);
    }
  });

  it('1. happy path: initiate → accept → end, with timing', async () => {
    const call = newCall();

    const accepted = await act(callee, call, 'accept');
    expect(accepted.status).toBe(CallStatus.Active);
    expect(accepted.answeredAt).toBeInstanceOf(Date);

    // Pretend the call has been running for 4m12s.
    model.docs.get(String(call._id)).answeredAt = new Date(Date.now() - 252_000);

    const ended = await act(caller, call, 'end');
    expect(ended.status).toBe(CallStatus.Ended);
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(ended.durationSeconds).toBeGreaterThanOrEqual(251);
    expect(ended.durationSeconds).toBeLessThanOrEqual(253);
    expect(ended.endedReason).toBe(CallEndReason.HungUp);
    expect(String(model.docs.get(String(call._id)).endedBy)).toBe(String(caller._id));
  });

  it('2. reject → rejected, rejectedBy populated, zero duration', async () => {
    const call = newCall();

    const res = await act(callee, call, 'reject');

    expect(res).toMatchObject({
      status: CallStatus.Rejected,
      durationSeconds: 0,
      endedReason: CallEndReason.Rejected,
    });
    expect(model.docs.get(String(call._id)).rejectedBy.map(String)).toEqual([String(callee._id)]);
  });

  it('3. cancel by the initiator → cancelled', async () => {
    const res = await act(caller, newCall(), 'cancel');

    expect(res).toMatchObject({
      status: CallStatus.Cancelled,
      endedReason: CallEndReason.CancelledByCaller,
    });
  });

  it('4. cancel attempted by the callee → 403 ACTION_NOT_ALLOWED', async () => {
    const err = await failure(act(callee, newCall(), 'cancel'));

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe(CallErrorCode.ActionNotAllowed);
  });

  it.each(['accept', 'reject'])('the caller cannot %s their own call', async (action) => {
    const err = await failure(act(caller, newCall(), action));

    expect(err.getResponse().code).toBe(CallErrorCode.ActionNotAllowed);
  });

  it('5. accept twice → both succeed, exactly one state change', async () => {
    const call = newCall();

    const first = await act(callee, call, 'accept');
    const second = await act(callee, call, 'accept');

    expect(second.status).toBe(CallStatus.Active);
    expect(second.answeredAt).toEqual(first.answeredAt); // not re-stamped
  });

  it('6. ending an already-ended call → 409 CALL_ALREADY_ENDED, no write', async () => {
    const call = newCall({ status: CallStatus.Rejected, endedAt: new Date() });
    const before = clone(model.docs.get(String(call._id)));

    const err = await failure(act(caller, call, 'end'));

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(CallErrorCode.CallAlreadyEnded);
    expect(model.docs.get(String(call._id))).toEqual(before);
  });

  it('accepting a call that already timed out → 409, so the client shows "Call ended"', async () => {
    const call = newCall({ status: CallStatus.Missed });

    const err = await failure(act(callee, call, 'accept'));

    expect(err.getResponse().code).toBe(CallErrorCode.CallAlreadyEnded);
  });

  it('ending a still-ringing call is illegal (the caller must cancel, the callee reject)', async () => {
    const err = await failure(act(caller, newCall(), 'end'));

    expect(err.getResponse().code).toBe(CallErrorCode.IllegalTransition);
  });

  it('7. a third party → 403 NOT_PARTICIPANT', async () => {
    const err = await failure(act(stranger, newCall({ status: CallStatus.Active }), 'end'));

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe(CallErrorCode.NotParticipant);
  });

  it('unknown or malformed call id → 404', async () => {
    await expect(service.performAction(caller, new Types.ObjectId().toString(), 'end')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.performAction(caller, 'nope', 'end')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('both hang up at once: the first wins, the second is an idempotent no-op', async () => {
    const call = newCall({ status: CallStatus.Active, answeredAt: new Date() });

    const [a, b] = await Promise.all([act(caller, call, 'end'), act(callee, call, 'end')]);

    expect(a.status).toBe(CallStatus.Ended);
    expect(b.status).toBe(CallStatus.Ended);
    expect(a.endedAt).toEqual(b.endedAt); // one write
  });

  it('a concurrent writer between read and write: re-evaluated against the new status', async () => {
    const call = newCall();
    // The ring timeout lands right as the callee accepts.
    model.beforeWrite = (id) => {
      model.beforeWrite = null;
      model.docs.get(id).status = CallStatus.Missed;
    };

    const err = await failure(act(callee, call, 'accept'));

    expect(err.getResponse().code).toBe(CallErrorCode.CallAlreadyEnded);
    expect(model.docs.get(String(call._id)).status).toBe(CallStatus.Missed);
  });

  describe('8. terminateBetween (mid-call block)', () => {
    it('ends an active call, cancels a ringing one, and drops both on Stream', async () => {
      const active = newCall({ status: CallStatus.Active, answeredAt: new Date() });
      const ringing = newCall();
      const unrelated = newCall({ participants: [caller._id, stranger._id], status: CallStatus.Active });

      const n = await service.terminateBetween(String(callee._id), String(caller._id), {
        actorId: String(callee._id),
      });

      expect(n).toBe(2);
      expect(model.docs.get(String(active._id))).toMatchObject({
        status: CallStatus.Ended,
        endedReason: CallEndReason.Blocked,
      });
      expect(model.docs.get(String(ringing._id))).toMatchObject({
        status: CallStatus.Cancelled,
        endedReason: CallEndReason.Blocked,
      });
      expect(model.docs.get(String(unrelated._id)).status).toBe(CallStatus.Active);
      expect(streamVideo.endCall).toHaveBeenCalledWith(active.streamCallId);
      expect(streamVideo.endCall).toHaveBeenCalledWith(ringing.streamCallId);
      expect(streamVideo.endCall).toHaveBeenCalledTimes(2);
    });

    it('never throws, even when Stream fails', async () => {
      newCall({ status: CallStatus.Active, answeredAt: new Date() });
      streamVideo.endCall.mockRejectedValue(new Error('Stream down'));

      await expect(
        service.terminateBetween(String(caller._id), String(callee._id)),
      ).resolves.toBe(1);
    });

    it('does nothing when there is no live call', async () => {
      newCall({ status: CallStatus.Ended });

      await expect(
        service.terminateBetween(String(caller._id), String(callee._id)),
      ).resolves.toBe(0);
      expect(streamVideo.endCall).not.toHaveBeenCalled();
    });
  });
  describe('ring timeout (Iteration 9)', () => {
    it('leaving ringing by any route removes the pending timeout job', async () => {
      const call = newCall();

      await act(callee, call, 'accept');
      await new Promise((r) => setImmediate(r)); // removal is fire-and-forget

      expect(queue.getJob).toHaveBeenCalledWith(String(call._id));
      expect(job.remove).toHaveBeenCalled();
    });

    it('the webhook / block path removes it too (it lives in applyTransition)', async () => {
      const call = newCall();

      await service.applyTransition(call._id, CallStatus.Cancelled, { reason: CallEndReason.Blocked });
      await new Promise((r) => setImmediate(r));

      expect(job.remove).toHaveBeenCalled();
    });

    it('transitions out of active do not touch the queue', async () => {
      const call = newCall({ status: CallStatus.Active, answeredAt: new Date() });

      await act(caller, call, 'end');
      await new Promise((r) => setImmediate(r));

      expect(queue.getJob).not.toHaveBeenCalled();
    });

    it('a failed job removal is harmless', async () => {
      job.remove.mockRejectedValue(new Error('job is locked'));

      await expect(act(callee, newCall(), 'accept')).resolves.toMatchObject({ status: CallStatus.Active });
    });

    it('1. an unanswered call becomes missed and stops ringing on Stream', async () => {
      const call = newCall();

      await expect(service.expireRingingCall(call._id, { fromRingTimeout: true })).resolves.toBe(true);

      expect(model.docs.get(String(call._id))).toMatchObject({
        status: CallStatus.Missed,
        endedReason: CallEndReason.RingTimeout,
        durationSeconds: 0,
      });
      expect(streamVideo.endCall).toHaveBeenCalledWith(call.streamCallId);
      // The running job must not try to remove itself.
      expect(queue.getJob).not.toHaveBeenCalled();
    });

    it('2. an answered call is left alone', async () => {
      const call = newCall({ status: CallStatus.Active, answeredAt: new Date() });

      await expect(service.expireRingingCall(call._id)).resolves.toBe(false);
      expect(model.docs.get(String(call._id)).status).toBe(CallStatus.Active);
      expect(streamVideo.endCall).not.toHaveBeenCalled();
    });

    it('race: answered between the timeout reading and writing — the answer wins, no false missed', async () => {
      const call = newCall();
      model.beforeWrite = (id) => {
        model.beforeWrite = null;
        const doc = model.docs.get(id);
        doc.status = CallStatus.Active;
        doc.answeredAt = new Date();
      };

      await expect(service.expireRingingCall(call._id)).resolves.toBe(false);
      expect(model.docs.get(String(call._id)).status).toBe(CallStatus.Active);
      expect(streamVideo.endCall).not.toHaveBeenCalled();
    });

    it('still records missed when Stream cannot be told to stop ringing', async () => {
      streamVideo.endCall.mockRejectedValue(new Error('Stream down'));
      const call = newCall();

      await expect(service.expireRingingCall(call._id)).resolves.toBe(true);
      expect(model.docs.get(String(call._id)).status).toBe(CallStatus.Missed);
    });

    it('a deleted or unknown call is a no-op', async () => {
      await expect(service.expireRingingCall(new Types.ObjectId())).resolves.toBe(false);
    });

    it('maxDurationSeconds caps the recorded duration', async () => {
      const call = newCall({
        status: CallStatus.Active,
        answeredAt: new Date(Date.now() - 8 * 3600_000),
      });

      await service.applyTransition(call._id, CallStatus.Ended, { maxDurationSeconds: 6 * 3600 });

      expect(model.docs.get(String(call._id)).durationSeconds).toBe(6 * 3600);
    });
  });
  describe('post-call events (Iteration 10)', () => {
    it('fire once when a call reaches a terminal status, with the final record', async () => {
      const call = newCall({ status: CallStatus.Active, answeredAt: new Date() });

      await act(caller, call, 'end');
      await act(callee, call, 'end'); // idempotent repeat

      expect(callEvents.onCallTerminated).toHaveBeenCalledTimes(1);
      expect(callEvents.onCallTerminated.mock.calls[0][0]).toMatchObject({
        status: CallStatus.Ended,
        durationSeconds: expect.any(Number),
      });
    });

    it('do not fire on a non-terminal transition (accept)', async () => {
      await act(callee, newCall(), 'accept');

      expect(callEvents.onCallTerminated).not.toHaveBeenCalled();
    });

    it('fire for a ring timeout (missed) too', async () => {
      await service.expireRingingCall(newCall()._id, { fromRingTimeout: true });

      expect(callEvents.onCallTerminated.mock.calls[0][0].status).toBe(CallStatus.Missed);
    });

    it('a failing side effect never fails the transition', async () => {
      callEvents.onCallTerminated.mockRejectedValue(new Error('chat down'));

      await expect(act(callee, newCall(), 'reject')).resolves.toMatchObject({
        status: CallStatus.Rejected,
      });
    });
  });
});
