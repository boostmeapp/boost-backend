import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Call } from '../../database/schemas/call/call.schema';
import { User } from '../../database/schemas/user/user.schema';
import { displayName } from '../../common/utils/display-name.util';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { RedisService } from '../redis/redis.service';
import { CallEndReason, CallStatus, CallType } from './call.constants';

/** One missed-call notification per caller → callee in this window. */
export const MISSED_CALL_NOTIFY_WINDOW_SECONDS = 15 * 60;

/** "4:12", or "1:02:03" past an hour. */
export const formatCallDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/**
 * The readable summary stored as the message text and conversation preview.
 * Neutral wording, because both participants see the same message.
 */
export const callEventText = (
  status: CallStatus,
  callType: CallType,
  durationSeconds = 0,
): string | null => {
  const kind = callType === CallType.Video ? 'video call' : 'voice call';
  const Kind = kind[0].toUpperCase() + kind.slice(1);
  switch (status) {
    case CallStatus.Ended:
      return `${Kind} · ${formatCallDuration(durationSeconds)}`;
    case CallStatus.Missed:
      return `Missed ${kind}`;
    case CallStatus.Rejected:
      return `Declined ${kind}`;
    case CallStatus.Cancelled:
      return `Cancelled ${kind}`;
    default:
      return null; // failed / live: nothing worth showing in the thread
  }
};

/**
 * What happens after a call reaches a terminal status: a record in its chat
 * thread, and a missed-call notification for the callee. Runs detached from
 * the transition and never throws — a failed side effect must never undo or
 * block a correct call record.
 */
@Injectable()
export class CallEventsService {
  private readonly logger = new Logger(CallEventsService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly notificationService: NotificationService,
    private readonly redis: RedisService,
  ) {}

  async onCallTerminated(call: Call): Promise<void> {
    const initiatorId = String(call.initiator);
    const calleeId = call.participants.map(String).find((p) => p !== initiatorId);
    if (!calleeId) return;

    await Promise.all([
      this.writeChatEvent(call, initiatorId, calleeId).catch((err) =>
        this.logger.error(`Call ${call._id}: chat event not written: ${err.message}`),
      ),
      this.notifyMissed(call, initiatorId, calleeId).catch((err) =>
        this.logger.error(`Call ${call._id}: missed-call notification failed: ${err.message}`),
      ),
    ]);
  }

  private async writeChatEvent(call: Call, initiatorId: string, calleeId: string) {
    // Started from a profile: no thread to write to.
    if (!call.conversation) return;
    // A block ended it: don't put a fresh message in front of either side.
    if (call.endedReason === CallEndReason.Blocked) return;

    const text = callEventText(call.status, call.callType, call.durationSeconds ?? 0);
    if (!text) return;

    const conversationId = String(call.conversation);
    const message = await this.chatService.createCallEventMessage({
      conversationId,
      initiatorId,
      calleeId,
      text,
      call: {
        callId: String(call._id),
        callType: call.callType,
        status: call.status,
        durationSeconds: call.durationSeconds ?? 0,
      },
      // The callee never picked up — surface it as unread for them.
      countAsUnread:
        call.status === CallStatus.Missed || call.status === CallStatus.Cancelled,
    });

    this.chatGateway.broadcastMessage(conversationId, message, [initiatorId, calleeId]);
  }

  /** Callee only, missed only — a deliberate rejection is not a missed call. */
  private async notifyMissed(call: Call, initiatorId: string, calleeId: string) {
    if (call.status !== CallStatus.Missed) return;

    // Collapse repeated missed calls from the same caller. If Redis is down,
    // err on the side of notifying.
    const first = await this.redis
      .setIfAbsent(
        `call:missed-notify:${initiatorId}:${calleeId}`,
        MISSED_CALL_NOTIFY_WINDOW_SECONDS,
      )
      .catch(() => true);
    if (!first) return;

    const caller = await this.userModel
      .findById(initiatorId)
      .select('username firstName lastName')
      .lean();
    const name = displayName(caller);
    const kind = call.callType === CallType.Video ? 'video call' : 'voice call';

    await this.notificationService.notify({
      users: calleeId,
      actor: initiatorId,
      type: NotificationType.MissedCall,
      title: name,
      body: `Missed ${kind} from ${name}`,
      metadata: {
        callId: String(call._id),
        callerId: initiatorId,
        callType: call.callType,
        ...(call.conversation && { conversationId: String(call.conversation) }),
      },
    });
  }
}
