import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { User } from '../../database/schemas/user/user.schema';
import { Call } from '../../database/schemas/call/call.schema';
import { Conversation } from '../../database/schemas/chat/conversation.schema';
import { displayName } from '../../common/utils/display-name.util';
import { RedisService } from '../redis/redis.service';
import { StreamUserProfile, StreamVideoService } from './stream-video.service';
import { CallAuthorizationService } from './call-authorization.service';
import { InitiateCallDto } from './dto/initiate-call.dto';
import { ENV } from '../../config';
import {
  ApnsEnvironment,
  CALL_INIT_LOCK_TTL_SECONDS,
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

    // TODO(Iteration 9): enqueue the ring-timeout job (jobId: callId).

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
