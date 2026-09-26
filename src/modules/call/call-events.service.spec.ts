import { Types } from 'mongoose';
import {
  CallEventsService,
  callEventText,
  formatCallDuration,
  MISSED_CALL_NOTIFY_WINDOW_SECONDS,
} from './call-events.service';
import { CallEndReason, CallStatus, CallType } from './call.constants';
import { NotificationType } from '../notification/notification.constants';

describe('call event text', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [252, '4:12'],
    [3599, '59:59'],
    [3723, '1:02:03'],
  ])('formats %ss as %s', (s, out) => {
    expect(formatCallDuration(s)).toBe(out);
  });

  it.each([
    [CallStatus.Ended, CallType.Audio, 252, 'Voice call · 4:12'],
    [CallStatus.Ended, CallType.Video, 61, 'Video call · 1:01'],
    [CallStatus.Missed, CallType.Video, 0, 'Missed video call'],
    [CallStatus.Rejected, CallType.Audio, 0, 'Declined voice call'],
    [CallStatus.Cancelled, CallType.Audio, 0, 'Cancelled voice call'],
    [CallStatus.Failed, CallType.Audio, 0, null],
  ])('%s %s → %j', (status, type, d, out) => {
    expect(callEventText(status, type, d)).toBe(out);
  });
});

describe('CallEventsService.onCallTerminated', () => {
  let initiator: Types.ObjectId;
  let callee: Types.ObjectId;
  let conversation: Types.ObjectId;
  let chatService: { createCallEventMessage: jest.Mock };
  let chatGateway: { broadcastMessage: jest.Mock };
  let notificationService: { notify: jest.Mock };
  let redis: { setIfAbsent: jest.Mock };
  let service: CallEventsService;

  const call = (overrides: Record<string, unknown> = {}) =>
    ({
      _id: new Types.ObjectId(),
      initiator,
      participants: [initiator, callee],
      conversation,
      streamCallId: 'default:ring-abc',
      callType: CallType.Video,
      status: CallStatus.Ended,
      durationSeconds: 252,
      ...overrides,
    }) as any;

  beforeEach(() => {
    initiator = new Types.ObjectId();
    callee = new Types.ObjectId();
    conversation = new Types.ObjectId();
    chatService = { createCallEventMessage: jest.fn().mockResolvedValue({ _id: 'm1' }) };
    chatGateway = { broadcastMessage: jest.fn() };
    notificationService = { notify: jest.fn().mockResolvedValue(['n1']) };
    redis = { setIfAbsent: jest.fn().mockResolvedValue(true) };
    const userModel = {
      findById: () => ({ select: () => ({ lean: async () => ({ username: 'alexandra' }) }) }),
    };
    service = new CallEventsService(
      userModel as any,
      chatService as any,
      chatGateway as any,
      notificationService as any,
      redis as any,
    );
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  });

  describe('chat thread', () => {
    it('writes a call message with a readable summary and broadcasts it to both users', async () => {
      const c = call();

      await service.onCallTerminated(c);

      expect(chatService.createCallEventMessage).toHaveBeenCalledWith({
        conversationId: String(conversation),
        initiatorId: String(initiator),
        calleeId: String(callee),
        text: 'Video call · 4:12',
        call: {
          callId: String(c._id),
          callType: CallType.Video,
          status: CallStatus.Ended,
          durationSeconds: 252,
        },
        countAsUnread: false,
      });
      expect(chatGateway.broadcastMessage).toHaveBeenCalledWith(
        String(conversation),
        { _id: 'm1' },
        [String(initiator), String(callee)],
      );
    });

    it.each([CallStatus.Missed, CallStatus.Cancelled])(
      'a %s call counts as unread for the callee',
      async (status) => {
        await service.onCallTerminated(call({ status, durationSeconds: 0 }));

        expect(chatService.createCallEventMessage.mock.calls[0][0].countAsUnread).toBe(true);
      },
    );

    it('skips calls started from a profile (no conversation)', async () => {
      await service.onCallTerminated(call({ conversation: undefined }));

      expect(chatService.createCallEventMessage).not.toHaveBeenCalled();
    });

    it('skips calls ended by a block', async () => {
      await service.onCallTerminated(call({ endedReason: CallEndReason.Blocked }));

      expect(chatService.createCallEventMessage).not.toHaveBeenCalled();
    });

    it('skips failed calls', async () => {
      await service.onCallTerminated(call({ status: CallStatus.Failed }));

      expect(chatService.createCallEventMessage).not.toHaveBeenCalled();
    });

    it('a failed chat write is logged and never throws', async () => {
      chatService.createCallEventMessage.mockRejectedValue(new Error('Mongo down'));

      await expect(service.onCallTerminated(call())).resolves.toBeUndefined();
      expect(chatGateway.broadcastMessage).not.toHaveBeenCalled();
    });
  });

  describe('missed-call notification', () => {
    it('notifies the callee only, with call-back data', async () => {
      const c = call({ status: CallStatus.Missed, durationSeconds: 0 });

      await service.onCallTerminated(c);

      expect(notificationService.notify).toHaveBeenCalledWith({
        users: String(callee),
        actor: String(initiator),
        type: NotificationType.MissedCall,
        title: 'alexandra',
        body: 'Missed video call from alexandra',
        metadata: {
          callId: String(c._id),
          streamCallId: 'default:ring-abc',
          callerId: String(initiator),
          callType: CallType.Video,
          conversationId: String(conversation),
        },
      });
    });

    it.each([CallStatus.Ended, CallStatus.Rejected, CallStatus.Cancelled])(
      'does not notify for %s (a deliberate rejection is not a missed call)',
      async (status) => {
        await service.onCallTerminated(call({ status }));

        expect(notificationService.notify).not.toHaveBeenCalled();
      },
    );

    it('collapses repeat missed calls from the same caller within 15 minutes', async () => {
      redis.setIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await service.onCallTerminated(call({ status: CallStatus.Missed }));
      await service.onCallTerminated(call({ status: CallStatus.Missed }));

      expect(notificationService.notify).toHaveBeenCalledTimes(1);
      expect(redis.setIfAbsent).toHaveBeenCalledWith(
        `call:missed-notify:${initiator}:${callee}`,
        MISSED_CALL_NOTIFY_WINDOW_SECONDS,
      );
    });

    it('notifies anyway when Redis is down', async () => {
      redis.setIfAbsent.mockRejectedValue(new Error('ECONNREFUSED'));

      await service.onCallTerminated(call({ status: CallStatus.Missed }));

      expect(notificationService.notify).toHaveBeenCalled();
    });

    it('omits conversationId for a call started from a profile', async () => {
      await service.onCallTerminated(call({ status: CallStatus.Missed, conversation: undefined }));

      expect(notificationService.notify.mock.calls[0][0].metadata).not.toHaveProperty('conversationId');
    });
  });
});
