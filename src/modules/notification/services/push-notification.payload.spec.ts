import { NotificationType } from '../notification.constants';
import { PUSH_CATEGORY_BY_TYPE, PushNotificationService } from './push-notification.service';

// basePayload is pure; call it without the Firebase / Mongo dependencies.
const payload = (type: string, metadata: Record<string, any> = {}) =>
  (Object.create(PushNotificationService.prototype) as any).basePayload(type, metadata);

describe('push payload', () => {
  it('missed-call pushes carry the iOS category the app adds "Call back" to', () => {
    expect(PUSH_CATEGORY_BY_TYPE[NotificationType.MissedCall]).toBe('MISSED_CALL');
    const p = payload(NotificationType.MissedCall, { callId: 'c', callerId: 'u', callType: 'video' });
    expect(p.apns.payload.aps).toEqual({ sound: 'default', category: 'MISSED_CALL' });
    expect(p.data).toEqual({
      type: 'MissedCall',
      metadata: JSON.stringify({ callId: 'c', callerId: 'u', callType: 'video' }),
    });
  });

  it('other pushes have no category', () => {
    expect(payload('Follow').apns.payload.aps).toEqual({ sound: 'default' });
  });
});
