import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { User } from '../../database/schemas/user/user.schema';
import { Call } from '../../database/schemas/call/call.schema';
import { Conversation } from '../../database/schemas/chat/conversation.schema';
import { displayName } from '../../common/utils/display-name.util';
import { RedisService } from '../redis/redis.service';
import { StreamUserProfile, StreamVideoService } from './stream-video.service';
import { CallAuthorizationService } from './call-authorization.service';
import { CallEventsService } from './call-events.service';
import { CallHistoryQueryDto } from './dto/call-history-query.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { InitiateCallDto } from './dto/initiate-call.dto';
import { ENV } from '../../config';
import {
  ApnsEnvironment,
  CALL_INIT_LOCK_TTL_SECONDS,
  CALL_QUEUE,
  CallJobs,
  RingTimeoutJob,
  CALL_TRANSITIONS,
  DEFAULT_END_REASON,
  isTerminalStatus,
  CallEndReason,
  CallErrorCode,
  CallStatus,
  CallType,
  LIVE_CALL_STATUSES,
  STREAM_CALL_TYPE,
  STREAM_TOKEN_VALIDITY_SECONDS,
} from './call.constants';

export interface StreamTokenResponse {
  apiKey: string;
  token: string;
  userId: string;
  expiresAt: string;
  /** Provider names the app passes to Stream when registering device tokens. */
  push: {
    apnsEnvironment: ApnsEnvironment;
    apnProviderName: string;
    firebaseProviderName: string;
  };
}

export interface InitiateCallResponse {
  /** Our record id — used for /calls/:id/* lifecycle endpoints. */
  callId: string;
  /** Stream cid, `<type>:<id>`. */
  streamCallId: string;
  /** The same cid split, so the client can `client.call(type, id)` without parsing. */
  stream: { type: string; id: string };
  callType: CallType;
  callee: StreamUserProfile;
  createdAt: Date;
}

export interface CallHistoryItem {
  callId: string;
  callType: CallType;
  status: CallStatus;
  /** Relative to the requester, so the client never has to derive it. */
  direction: 'incoming' | 'outgoing';
  /** The other participant. id is null when their account is gone. */
  otherParticipant: { id: string | null; name: string; image: string | null };
  conversationId: string | null;
  ringStartedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  endedReason: CallEndReason | null;
  createdAt: Date;
}

/** What a participant reports through /calls/:id/<action>. */
export type CallAction = 'accept' | 'reject' | 'cancel' | 'end';

export interface CallSummary {
  callId: string;
  status: CallStatus;
  callType: CallType;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  endedReason: CallEndReason | null;
}

export interface TransitionResult {
  call: Call;
  /** False when the call already held the target status — an idempotent no-op. */
  changed: boolean;
}

const ACTION_TARGET: Record<CallAction, CallStatus> = {
  accept: CallStatus.Active,
  reject: CallStatus.Rejected,
  cancel: CallStatus.Cancelled,
  end: CallStatus.Ended,
};

/** Who may perform each action, beyond being a participant. */
const ACTION_ROLE: Record<CallAction, 'initiator' | 'callee' | 'any'> = {
  accept: 'callee',
  reject: 'callee',
  cancel: 'initiator',
  end: 'any',
};

/** Retries when a concurrent writer moves the status between our read and write. */
const TRANSITION_ATTEMPTS = 3;

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<Call>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<Conversation>,
    private readonly streamVideo: StreamVideoService,
    private readonly callAuthorization: CallAuthorizationService,
    private readonly redis: RedisService,
    @InjectQueue(CALL_QUEUE) private readonly callQueue: Queue<RingTimeoutJob>,
    private readonly callEvents: CallEventsService,
  ) {}

  /**
   * The auth bridge: a Boostra user gets a Stream token for themselves. Also the
   * narrowest choke point for revoking calling access.
   */
  async issueToken(
    user: User,
    apnsEnvironment: ApnsEnvironment = ApnsEnvironment.Production,
  ): Promise<StreamTokenResponse> {
    // Throws 503 before anything else when calling is disabled.
    const apiKey = this.streamVideo.getApiKey();

    // Inactive users never get this far — the JWT strategy rejects them with 401.
    if (user.isBanned) {
      throw new ForbiddenException({
        message: 'Calling is not available for this account',
        code: CallErrorCode.AccountBanned,
      });
    }

    // The Mongo _id is immutable; usernames and emails are not.
    const userId = user._id.toString();

    // Upserted on every issue so name/avatar edits self-heal. A missing avatar
    // must not block a call, so a failure here is logged, not thrown.
    try {
      await this.streamVideo.upsertUser(this.toStreamProfile(user));
    } catch (err) {
      this.logger.warn(
        `Stream upsert failed for user ${userId}: ${(err as Error).message}`,
      );
    }

    const token = this.streamVideo.generateUserToken(
      userId,
      STREAM_TOKEN_VALIDITY_SECONDS,
    );

    return {
      apiKey,
      token,
      userId,
      expiresAt: new Date(
        Date.now() + STREAM_TOKEN_VALIDITY_SECONDS * 1000,
      ).toISOString(),
      push: {
        apnsEnvironment,
        // Chosen by the *app build's* APNs environment, never by NODE_ENV:
        // staging builds are production-APNs but talk to the dev backend.
        apnProviderName:
          apnsEnvironment === ApnsEnvironment.Development
            ? ENV.STREAM_APN_PROVIDER_SANDBOX
            : ENV.STREAM_APN_PROVIDER_PRODUCTION,
        firebaseProviderName: ENV.STREAM_FIREBASE_PROVIDER,
      },
    };
  }

  /**
   * Start a ringing call: authorize, reserve both parties, persist, then ring
   * on Stream. The record is written *before* Stream so a failure leaves a
   * `failed` record, never a ringing phone with no record.
   */
  async initiate(caller: User, dto: InitiateCallDto): Promise<InitiateCallResponse> {
    this.streamVideo.getClient(); // 503 when calling is disabled

    const callerId = caller._id.toString();
    const { calleeId, callType, conversationId } = dto;

    await this.callAuthorization.assertCanCall(callerId, calleeId);

    if (conversationId) {
      await this.assertConversationBetween(conversationId, callerId, calleeId);
    }

    // TODO(Iteration 11): per-caller rate limit and reject-backoff go here.

    const callee = await this.userModel
      .findById(calleeId)
      .select('_id username firstName lastName profileImage')
      .lean();
    // assertCanCall has just confirmed the callee exists; this guards the race.
    if (!callee) {
      throw new ForbiddenException({
        message: "This user can't be called right now",
        code: CallErrorCode.UserUnavailable,
      });
    }

    const streamId = randomUUID(); // never derived from user ids — unguessable
    const streamCallId = `${STREAM_CALL_TYPE}:${streamId}`;

    const call = await this.withInitiationLocks(callerId, calleeId, async () => {
      await this.assertNotBusy(callerId, calleeId);

      return this.callModel.create({
        streamCallId,
        callType,
        initiator: new Types.ObjectId(callerId),
        participants: [new Types.ObjectId(callerId), new Types.ObjectId(calleeId)],
        ...(conversationId && { conversation: new Types.ObjectId(conversationId) }),
        status: CallStatus.Ringing,
        ringStartedAt: new Date(),
      });
    });

    const callerProfile = this.toStreamProfile(caller);
    const calleeProfile = this.toStreamProfile(callee);

    try {
      // Both must exist on Stream to be members. The callee may never have
      // fetched a token, so upsert both rather than assuming.
      await this.streamVideo.upsertUsers([callerProfile, calleeProfile]);
      await this.streamVideo.createRingingCall({
        type: STREAM_CALL_TYPE,
        id: streamId,
        callerId,
        calleeId,
        video: callType === CallType.Video,
        custom: {
          callId: call._id.toString(),
          callType,
          ...(conversationId && { conversationId }),
        },
      });
    } catch (err) {
      await this.callModel.updateOne(
        { _id: call._id, status: CallStatus.Ringing },
        {
          status: CallStatus.Failed,
          endedReason: CallEndReason.NetworkFailure,
          endedAt: new Date(),
        },
      );
      this.logger.error(
        `Stream call creation failed for ${call._id} (${callerId} -> ${calleeId}): ${(err as Error).message}`,
      );
      throw new BadGatewayException({
        message: 'Could not start the call. Please try again.',
        code: CallErrorCode.CallFailed,
      });
    }

    await this.scheduleRingTimeout(call._id.toString());

    this.logger.log(
      `Call ${call._id} ringing: ${callerId} -> ${calleeId} (${callType}, ${streamCallId})`,
    );

    return {
      callId: call._id.toString(),
      streamCallId,
      stream: { type: STREAM_CALL_TYPE, id: streamId },
      callType,
      callee: calleeProfile,
      createdAt: call.createdAt,
    };
  }

  /**
   * The requester's call history, newest first. Always scoped to calls the
   * requester took part in — the user id never comes from the query string.
   * Served by the { participants: 1, createdAt: -1 } index.
   */
  async getHistory(
    user: User,
    query: CallHistoryQueryDto,
  ): Promise<PaginatedResult<CallHistoryItem>> {
    const userId = user._id.toString();
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const filter: Record<string, unknown> = {
      participants: new Types.ObjectId(userId),
    };
    if (query.conversationId) filter.conversation = new Types.ObjectId(query.conversationId);
    if (query.status) filter.status = query.status;

    const [rows, total] = await Promise.all([
      this.callModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // Only the display fields — never the full user document.
        .populate('participants', '_id username firstName lastName profileImage')
        .lean(),
      this.callModel.countDocuments(filter),
    ]);

    const data = rows.map((c: any): CallHistoryItem => {
      // A deleted account populates as null; keep the row, with a placeholder.
      const other = (c.participants as any[]).find(
        (p) => !p || String(p._id) !== userId,
      );
      return {
        callId: String(c._id),
        callType: c.callType,
        status: c.status,
        direction: String(c.initiator) === userId ? 'outgoing' : 'incoming',
        otherParticipant: other
          ? { id: String(other._id), name: displayName(other, 'Boostra user'), image: other.profileImage || null }
          : { id: null, name: 'Deleted user', image: null },
        conversationId: c.conversation ? String(c.conversation) : null,
        ringStartedAt: c.ringStartedAt,
        answeredAt: c.answeredAt ?? null,
        endedAt: c.endedAt ?? null,
        durationSeconds: c.durationSeconds ?? null,
        endedReason: c.endedReason ?? null,
        createdAt: c.createdAt,
      };
    });

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * A participant reports accept / reject / cancel / end. Record-keeping, not
   * control: the client already did it through the Stream SDK. The webhook
   * (Iteration 8) is the backstop when a client never reports.
   */
  async performAction(
    user: User,
    callId: string,
    action: CallAction,
  ): Promise<CallSummary> {
    const actorId = user._id.toString();
    const call = await this.findCallOrThrow(callId);

    // The call id alone is not authorization.
    if (!call.participants.some((p) => String(p) === actorId)) {
      throw new ForbiddenException({
        message: 'You are not part of this call',
        code: CallErrorCode.NotParticipant,
      });
    }

    const isInitiator = String(call.initiator) === actorId;
    const role = ACTION_ROLE[action];
    if (
      (role === 'initiator' && !isInitiator) ||
      (role === 'callee' && isInitiator)
    ) {
      throw new ForbiddenException({
        message: `You can't ${action} this call`,
        code: CallErrorCode.ActionNotAllowed,
      });
    }

    const { call: updated } = await this.applyTransition(
      call._id,
      ACTION_TARGET[action],
      { actorId },
    );

    return this.toSummary(updated);
  }

  /**
   * The one place call status changes. Enforces CALL_TRANSITIONS, is
   * idempotent (re-applying the current status is a no-op success, because
   * clients and webhooks both report the same events), and atomic (the write
   * is conditioned on the status we read, so concurrent writers can't both win).
   */
  async applyTransition(
    callId: Types.ObjectId | string,
    next: CallStatus,
    opts: {
      actorId?: string | null;
      reason?: CallEndReason;
      /** Cap the recorded duration — for orphaned calls closed by the sweeper. */
      maxDurationSeconds?: number;
      /** Set by the ring-timeout job itself, which must not try to remove its own job. */
      fromRingTimeout?: boolean;
    } = {},
  ): Promise<TransitionResult> {
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt++) {
      const current = await this.callModel.findById(callId).lean<Call>();
      if (!current) {
        throw new NotFoundException({
          message: 'Call not found',
          code: CallErrorCode.CallNotFound,
        });
      }

      if (current.status === next) {
        return { call: current, changed: false };
      }

      if (!CALL_TRANSITIONS[current.status].includes(next)) {
        const ended = isTerminalStatus(current.status);
        // Expected under normal races (late accept after timeout, duplicate
        // end); not worth more than an info line.
        this.logger.log(
          `Call ${current._id} ${current.status} -> ${next} refused (illegal transition)`,
        );
        throw new ConflictException({
          message: ended ? 'This call has already ended' : `Can't move a ${current.status} call to ${next}`,
          code: ended ? CallErrorCode.CallAlreadyEnded : CallErrorCode.IllegalTransition,
        });
      }

      const now = new Date();
      const set: Record<string, unknown> = { status: next };
      const update: Record<string, unknown> = { $set: set };

      if (next === CallStatus.Active) set.answeredAt = now;

      if (isTerminalStatus(next)) {
        set.endedAt = now;
        const duration = current.answeredAt
          ? Math.max(0, Math.round((now.getTime() - new Date(current.answeredAt).getTime()) / 1000))
          : 0;
        set.durationSeconds =
          opts.maxDurationSeconds !== undefined
            ? Math.min(duration, opts.maxDurationSeconds)
            : duration;
        set.endedReason = opts.reason ?? DEFAULT_END_REASON[next];
        if (opts.actorId) set.endedBy = new Types.ObjectId(opts.actorId);
      }

      if (next === CallStatus.Rejected && opts.actorId) {
        update.$addToSet = { rejectedBy: new Types.ObjectId(opts.actorId) };
      }

      const updated = await this.callModel
        .findOneAndUpdate({ _id: current._id, status: current.status }, update, { new: true })
        .lean<Call>();

      if (updated) {
        this.logger.log(
          `Call ${updated._id} ${current.status} -> ${next}` +
            ` actor=${opts.actorId ?? 'system'}` +
            (set.endedReason ? ` reason=${set.endedReason}` : '') +
            (isTerminalStatus(next) ? ` duration=${set.durationSeconds}s` : ''),
        );
        // Left ringing by any route (app, webhook, block): the timeout is moot.
        if (current.status === CallStatus.Ringing && !opts.fromRingTimeout) {
          void this.cancelRingTimeout(String(updated._id));
        }
        // Chat record + missed-call notification. Detached, and it never
        // throws, so it can't undo or delay a correct record. Runs once per
        // call because only the winning write reaches here.
        if (isTerminalStatus(next)) {
          this.callEvents
            .onCallTerminated(updated)
            .catch((err) =>
              this.logger.error(`Call ${updated._id}: post-call events failed: ${(err as Error).message}`),
            );
        }
        return { call: updated, changed: true };
      }
      // Someone else moved it between our read and write — re-evaluate.
    }

    throw new ConflictException({
      message: 'The call changed while updating. Please try again.',
      code: CallErrorCode.IllegalTransition,
    });
  }

  /**
   * End every live call between two users — used when one blocks the other
   * mid-call. Ringing calls become cancelled, active ones ended, both with
   * reason `blocked`; then Stream drops both clients. Never throws: a block
   * must succeed even if termination partly fails.
   */
  async terminateBetween(
    userA: string,
    userB: string,
    opts: { actorId?: string; reason?: CallEndReason } = {},
  ): Promise<number> {
    const reason = opts.reason ?? CallEndReason.Blocked;
    const live = await this.callModel
      .find({
        participants: { $all: [new Types.ObjectId(userA), new Types.ObjectId(userB)] },
        status: { $in: LIVE_CALL_STATUSES },
      })
      .select('_id status streamCallId')
      .lean();

    let terminated = 0;
    for (const call of live) {
      const next = call.status === CallStatus.Active ? CallStatus.Ended : CallStatus.Cancelled;
      try {
        const { changed } = await this.applyTransition(call._id, next, {
          actorId: opts.actorId,
          reason,
        });
        if (changed) terminated++;
      } catch (err) {
        // Already ended by someone else — fine; still make sure Stream drops it.
        this.logger.warn(`terminateBetween: ${call._id} not transitioned: ${(err as Error).message}`);
      }
      try {
        await this.streamVideo.endCall(call.streamCallId);
      } catch (err) {
        this.logger.error(`terminateBetween: Stream end failed for ${call._id}: ${(err as Error).message}`);
      }
    }
    return terminated;
  }

  /**
   * A ringing call nobody answered becomes missed, and Stream is told to end
   * it so the callee's device stops ringing. Used by the ring-timeout job and
   * the sweeper. Safe against the race with a last-second answer: the status
   * is re-read, and the transition is atomic — an answered call is untouched.
   * Returns whether this call did the expiring.
   */
  async expireRingingCall(
    callId: string | Types.ObjectId,
    opts: { fromRingTimeout?: boolean } = {},
  ): Promise<boolean> {
    const call = await this.callModel
      .findById(callId)
      .select('_id status streamCallId')
      .lean<Call>();
    if (!call || call.status !== CallStatus.Ringing) return false;

    let changed: boolean;
    try {
      ({ changed } = await this.applyTransition(call._id, CallStatus.Missed, {
        actorId: null,
        reason: CallEndReason.RingTimeout,
        fromRingTimeout: opts.fromRingTimeout,
      }));
    } catch (err) {
      if (err instanceof ConflictException) return false; // answered at the boundary
      throw err;
    }
    if (!changed) return false;

    try {
      await this.streamVideo.endCall(call.streamCallId);
    } catch (err) {
      this.logger.error(`Could not stop ringing for ${call._id}: ${(err as Error).message}`);
    }

    // The missed-call notification is sent by applyTransition's terminal hook.
    return true;
  }

  /**
   * Enqueue the ring timeout. Failure is logged loudly but never fails the
   * call: the sweeper resolves anything whose job was never enqueued.
   */
  private async scheduleRingTimeout(callId: string): Promise<void> {
    try {
      await this.callQueue.add(
        CallJobs.RingTimeout,
        { callId },
        {
          jobId: callId,
          delay: ENV.CALL_RING_TIMEOUT_SECONDS * 1000,
          attempts: 3,
          backoff: { type: 'fixed', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      this.logger.error(
        `Ring timeout NOT scheduled for call ${callId} — the sweeper will resolve it: ${(err as Error).message}`,
      );
    }
  }

  /** Best-effort. If it fails, the job's own status re-check makes it a no-op. */
  private async cancelRingTimeout(callId: string): Promise<void> {
    try {
      const job = await this.callQueue.getJob(callId);
      await job?.remove();
    } catch (err) {
      this.logger.debug(`Ring timeout job for ${callId} not removed: ${(err as Error).message}`);
    }
  }

  private async findCallOrThrow(callId: string): Promise<Call> {
    const call = Types.ObjectId.isValid(callId)
      ? await this.callModel.findById(callId).lean<Call>()
      : null;
    if (!call) {
      throw new NotFoundException({
        message: 'Call not found',
        code: CallErrorCode.CallNotFound,
      });
    }
    return call;
  }

  private toSummary(call: Call): CallSummary {
    return {
      callId: String(call._id),
      status: call.status,
      callType: call.callType,
      answeredAt: call.answeredAt ?? null,
      endedAt: call.endedAt ?? null,
      durationSeconds: call.durationSeconds ?? null,
      endedReason: call.endedReason ?? null,
    };
  }

  /** A call can only be attached to a thread both parties are in. */
  private async assertConversationBetween(
    conversationId: string,
    callerId: string,
    calleeId: string,
  ): Promise<void> {
    const exists = await this.conversationModel.exists({
      _id: new Types.ObjectId(conversationId),
      participants: {
        $all: [new Types.ObjectId(callerId), new Types.ObjectId(calleeId)],
      },
    });
    if (!exists) {
      throw new BadRequestException({
        message: 'Conversation not found for these users',
        code: CallErrorCode.InvalidConversation,
      });
    }
  }

  /** Either party already ringing or on a call → 409. The caller is checked first. */
  private async assertNotBusy(callerId: string, calleeId: string): Promise<void> {
    const live = await this.callModel
      .find({
        participants: {
          $in: [new Types.ObjectId(callerId), new Types.ObjectId(calleeId)],
        },
        status: { $in: LIVE_CALL_STATUSES },
      })
      .select('participants')
      .lean();

    const involves = (userId: string) =>
      live.some((c) => c.participants.some((p) => String(p) === userId));

    if (involves(callerId)) {
      throw new ConflictException({
        message: "You're already in a call",
        code: CallErrorCode.AlreadyInCall,
      });
    }
    if (involves(calleeId)) {
      throw new ConflictException({
        message: 'This user is on another call',
        code: CallErrorCode.CalleeBusy,
      });
    }
  }

  /**
   * Hold a short lock on *each* user (not the pair), so two different callers
   * cannot both pass the busy check for the same callee. Taken in id order to
   * avoid deadlock. Fails closed: no lock, no call.
   */
  private async withInitiationLocks<T>(
    callerId: string,
    calleeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    const held: string[] = [];

    try {
      for (const userId of [callerId, calleeId].sort()) {
        const key = `call:init-lock:${userId}`;
        let acquired: boolean;
        try {
          acquired = await this.redis.setIfAbsent(key, CALL_INIT_LOCK_TTL_SECONDS, token);
        } catch (err) {
          this.logger.error(`Call lock unavailable: ${(err as Error).message}`);
          throw new ServiceUnavailableException({
            message: 'Calling is temporarily unavailable. Please try again.',
            code: CallErrorCode.CallingUnavailable,
          });
        }
        if (!acquired) {
          throw userId === callerId
            ? new ConflictException({
                message: "You're already starting a call",
                code: CallErrorCode.AlreadyInCall,
              })
            : new ConflictException({
                message: 'This user is on another call',
                code: CallErrorCode.CalleeBusy,
              });
        }
        held.push(key);
      }

      return await fn();
    } finally {
      await Promise.all(
        held.map((key) =>
          this.redis.deleteIfEquals(key, token).catch(() => false),
        ),
      );
    }
  }

  private toStreamProfile(user: {
    _id: unknown;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    profileImage?: string | null;
  }): StreamUserProfile {
    return {
      id: String(user._id),
      name: displayName(user, 'Boostra user'),
      image: user.profileImage || undefined,
    };
  }
}
