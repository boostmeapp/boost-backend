import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Call } from '../../database/schemas/call/call.schema';
import { ENV } from '../../config';
import { CallService } from './call.service';
import { StreamVideoService } from './stream-video.service';
import { CallEndReason, CallStatus } from './call.constants';

/** The fields of Stream's call events this service reads. */
export interface StreamCallEvent {
  type: string;
  call_cid?: string;
  reason?: string;
  user?: { id?: string };
}

/** What happened to an event — for logs and tests. */
export type WebhookOutcome =
  | 'applied'
  | 'no_change'
  | 'ignored'
  | 'unknown_call'
  | 'rejected_transition'
  | 'disabled';

interface Transition {
  next: CallStatus;
  reason?: CallEndReason;
  actorId?: string | null;
}

/**
 * Maps Stream's authoritative call events onto our records, so history
 * self-heals when a client dies, loses network, or never reports. Every
 * change goes through CallService.applyTransition, whose idempotency makes
 * duplicate and out-of-order delivery harmless.
 */
@Injectable()
export class CallWebhookService {
  private readonly logger = new Logger(CallWebhookService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<Call>,
    private readonly callService: CallService,
    private readonly streamVideo: StreamVideoService,
  ) {}

  async handle(event: StreamCallEvent): Promise<WebhookOutcome> {
    if (!event.call_cid || !event.type?.startsWith('call.')) {
      this.logger.debug(`Webhook ${event.type} ignored (not a call event)`);
      return 'ignored';
    }

    const call = await this.callModel
      .findOne({ streamCallId: event.call_cid })
      .select('_id status initiator streamCallId')
      .lean<Call>();
    if (!call) {
      // A call created outside this backend (e.g. dashboard tests). Never create one.
      this.logger.log(`Webhook ${event.type} for unknown call ${event.call_cid}; ignored`);
      return 'unknown_call';
    }

    const transition = await this.toTransition(event, call);
    if (!transition) {
      this.logger.debug(`Webhook ${event.type} for ${call._id}: no mapping; ignored`);
      return 'ignored';
    }

    if (!ENV.STREAM_WEBHOOK_ENABLED) {
      this.logger.log(
        `Webhook ${event.type} for ${call._id} would move ${call.status} -> ${transition.next}; ingestion disabled`,
      );
      return 'disabled';
    }

    try {
      const { changed } = await this.callService.applyTransition(call._id, transition.next, {
        actorId: transition.actorId,
        reason: transition.reason,
      });
      return changed ? 'applied' : 'no_change';
    } catch (err) {
      // Out-of-order delivery (e.g. accepted after ended) lands here. That is
      // correct behaviour, so it is info, not an error.
      if (err instanceof ConflictException || err instanceof NotFoundException) {
        this.logger.log(
          `Webhook ${event.type} for ${call._id}: ${call.status} -> ${transition.next} refused (${(err as Error).message})`,
        );
        return 'rejected_transition';
      }
      throw err;
    }
  }

  private async toTransition(event: StreamCallEvent, call: Call): Promise<Transition | null> {
    const actorId = this.actorId(event);
    const byInitiator = actorId !== null && actorId === String(call.initiator);

    switch (event.type) {
      case 'call.accepted':
        return { next: CallStatus.Active, actorId };

      case 'call.rejected':
        // Stream reports the caller cancelling, and the ring timing out, as rejections.
        if (event.reason === 'timeout') {
          return { next: CallStatus.Missed, reason: CallEndReason.RingTimeout, actorId: null };
        }
        if (byInitiator || event.reason === 'cancel') {
          return { next: CallStatus.Cancelled, reason: CallEndReason.CancelledByCaller, actorId };
        }
        if (event.reason === 'busy') {
          return { next: CallStatus.Rejected, reason: CallEndReason.CalleeBusy, actorId };
        }
        return { next: CallStatus.Rejected, reason: CallEndReason.Rejected, actorId };

      case 'call.missed':
        return { next: CallStatus.Missed, reason: CallEndReason.RingTimeout, actorId: null };

      case 'call.ended':
        // Ended before anyone answered = the ring was called off.
        return call.status === CallStatus.Ringing
          ? { next: CallStatus.Cancelled, reason: CallEndReason.CancelledByCaller, actorId }
          : { next: CallStatus.Ended, reason: CallEndReason.HungUp, actorId };

      case 'call.session_ended':
        return call.status === CallStatus.Active
          ? { next: CallStatus.Ended, reason: CallEndReason.HungUp, actorId: null }
          : null;

      case 'call.session_participant_left': {
        // Someone dropping out doesn't end the call — the other may still be
        // there, or they may reconnect. Only an empty session does.
        if (call.status !== CallStatus.Active) return null;
        const remaining = await this.streamVideo.getSessionParticipantCount(call.streamCallId);
        return remaining === 0
          ? { next: CallStatus.Ended, reason: CallEndReason.NetworkFailure, actorId: null }
          : null;
      }

      default:
        return null;
    }
  }

  /** Stream user ids are our Mongo ids; anything else is not a Boostra user. */
  private actorId(event: StreamCallEvent): string | null {
    const id = event.user?.id;
    return id && Types.ObjectId.isValid(id) ? id : null;
  }
}
