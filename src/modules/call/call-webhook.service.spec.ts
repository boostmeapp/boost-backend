import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CallWebhookService } from './call-webhook.service';
import { ENV } from '../../config';
import { CallEndReason, CallStatus } from './call.constants';

describe('CallWebhookService', () => {
  const cid = 'default:5b1c1a52-0d7e-4a57-9a41-3f4a8e0c2b11';
  let env: Record<string, string>;
  let call: any;
  let callModel: { findOne: jest.Mock };
  let callService: { applyTransition: jest.Mock };
  let streamVideo: { getSessionParticipantCount: jest.Mock };
  let service: CallWebhookService;
  let callerId: string;
  let calleeId: string;

  const event = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    call_cid: cid,
    ...extra,
  });
  const lastTransition = () => callService.applyTransition.mock.calls.at(-1);

  beforeAll(() => {
    ENV.init({ get: (key: string, fallback: unknown) => env[key] ?? fallback } as any);
  });

  beforeEach(() => {
    env = {};
    callerId = new Types.ObjectId().toString();
    calleeId = new Types.ObjectId().toString();
    call = {
      _id: new Types.ObjectId(),
      status: CallStatus.Ringing,
      initiator: new Types.ObjectId(callerId),
      streamCallId: cid,
    };
    callModel = {
      findOne: jest.fn(() => ({ select: () => ({ lean: async () => call }) })),
    };
    callService = {
      applyTransition: jest.fn().mockResolvedValue({ call, changed: true }),
    };
    streamVideo = { getSessionParticipantCount: jest.fn().mockResolvedValue(0) };
    service = new CallWebhookService(
      callModel as any,
      callService as any,
      streamVideo as any,
    );
  });

  it('looks the call up by its Stream cid', async () => {
    await service.handle(event('call.accepted', { user: { id: calleeId } }));

    expect(callModel.findOne).toHaveBeenCalledWith({ streamCallId: cid });
  });

  it('call.accepted → active, attributed to the accepting user', async () => {
    await expect(
      service.handle(event('call.accepted', { user: { id: calleeId } })),
    ).resolves.toBe('applied');

    expect(lastTransition()).toEqual([call._id, CallStatus.Active, { actorId: calleeId, reason: undefined }]);
  });

  it.each([
    ['declined by the callee', { reason: 'decline' }, 'callee', CallStatus.Rejected, CallEndReason.Rejected],
    ['busy', { reason: 'busy' }, 'callee', CallStatus.Rejected, CallEndReason.CalleeBusy],
    ['cancelled by the caller', {}, 'caller', CallStatus.Cancelled, CallEndReason.CancelledByCaller],
    ['reason cancel', { reason: 'cancel' }, 'callee', CallStatus.Cancelled, CallEndReason.CancelledByCaller],
    ['timed out', { reason: 'timeout' }, 'callee', CallStatus.Missed, CallEndReason.RingTimeout],
  ])('call.rejected (%s)', async (_, extra, who, next, reason) => {
    const id = who === 'caller' ? callerId : calleeId;

    await service.handle(event('call.rejected', { ...extra, user: { id } }));

    expect(lastTransition()[1]).toBe(next);
    expect(lastTransition()[2].reason).toBe(reason);
  });

  it('call.missed → missed (ring timeout, no actor)', async () => {
    await service.handle(event('call.missed', { user: { id: calleeId } }));

    expect(lastTransition()).toEqual([
      call._id,
      CallStatus.Missed,
      { actorId: null, reason: CallEndReason.RingTimeout },
    ]);
  });

  it('call.ended on an active call → ended', async () => {
    call.status = CallStatus.Active;

    await service.handle(event('call.ended', { user: { id: callerId } }));

    expect(lastTransition()[1]).toBe(CallStatus.Ended);
    expect(lastTransition()[2]).toEqual({ actorId: callerId, reason: CallEndReason.HungUp });
  });

  it('call.ended while still ringing → cancelled', async () => {
    await service.handle(event('call.ended', { user: { id: callerId } }));

    expect(lastTransition()[1]).toBe(CallStatus.Cancelled);
  });

  it('call.session_ended on an active call → ended; on anything else, ignored', async () => {
    call.status = CallStatus.Active;
    await expect(service.handle(event('call.session_ended'))).resolves.toBe('applied');
    expect(lastTransition()[1]).toBe(CallStatus.Ended);

    call.status = CallStatus.Ringing;
    callService.applyTransition.mockClear();
    await expect(service.handle(event('call.session_ended'))).resolves.toBe('ignored');
    expect(callService.applyTransition).not.toHaveBeenCalled();
  });

  describe('call.session_participant_left (the app was killed mid-call)', () => {
    beforeEach(() => {
      call.status = CallStatus.Active;
    });

    it('ends the call when nobody is left in the session', async () => {
      streamVideo.getSessionParticipantCount.mockResolvedValue(0);

      await expect(service.handle(event('call.session_participant_left'))).resolves.toBe('applied');
      expect(streamVideo.getSessionParticipantCount).toHaveBeenCalledWith(cid);
      expect(lastTransition()[1]).toBe(CallStatus.Ended);
      expect(lastTransition()[2].reason).toBe(CallEndReason.NetworkFailure);
    });

    it('leaves the call alone while someone is still in it', async () => {
      streamVideo.getSessionParticipantCount.mockResolvedValue(1);

      await expect(service.handle(event('call.session_participant_left'))).resolves.toBe('ignored');
      expect(callService.applyTransition).not.toHaveBeenCalled();
    });

    it('does not ask Stream when the call is not active', async () => {
      call.status = CallStatus.Ended;

      await service.handle(event('call.session_participant_left'));
      expect(streamVideo.getSessionParticipantCount).not.toHaveBeenCalled();
    });
  });

  it('duplicate delivery: reported as no_change, not an error', async () => {
    callService.applyTransition.mockResolvedValue({ call, changed: false });

    await expect(
      service.handle(event('call.accepted', { user: { id: calleeId } })),
    ).resolves.toBe('no_change');
  });

  it('out-of-order delivery (accepted after ended) is a logged no-op, not a throw', async () => {
    callService.applyTransition.mockRejectedValue(new ConflictException('already ended'));

    await expect(
      service.handle(event('call.accepted', { user: { id: calleeId } })),
    ).resolves.toBe('rejected_transition');
  });

  it('unexpected errors propagate, for the controller to log and still 200', async () => {
    callService.applyTransition.mockRejectedValue(new Error('Mongo down'));

    await expect(
      service.handle(event('call.accepted', { user: { id: calleeId } })),
    ).rejects.toThrow('Mongo down');
  });

  it('an unknown call_cid writes nothing', async () => {
    call = null;

    await expect(service.handle(event('call.ended'))).resolves.toBe('unknown_call');
    expect(callService.applyTransition).not.toHaveBeenCalled();
  });

  it.each(['call.created', 'call.ring', 'call.session_started', 'call.member_added'])(
    'acknowledges and ignores %s',
    async (type) => {
      await expect(service.handle(event(type))).resolves.toBe('ignored');
      expect(callService.applyTransition).not.toHaveBeenCalled();
    },
  );

  it('non-call events are ignored without a DB lookup', async () => {
    await expect(service.handle({ type: 'user.updated' } as any)).resolves.toBe('ignored');
    expect(callModel.findOne).not.toHaveBeenCalled();
  });

  it('a non-Boostra user id is never recorded as the actor', async () => {
    await service.handle(event('call.accepted', { user: { id: 'dashboard-admin' } }));

    expect(lastTransition()[2].actorId).toBeNull();
  });

  it('STREAM_WEBHOOK_ENABLED=false: verified and mapped, but nothing is written', async () => {
    env.STREAM_WEBHOOK_ENABLED = 'false';

    await expect(
      service.handle(event('call.accepted', { user: { id: calleeId } })),
    ).resolves.toBe('disabled');
    expect(callService.applyTransition).not.toHaveBeenCalled();
  });
});
