import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Follow, User } from '../../database/schemas';
import { ChatService } from '../chat/chat.service';
import {
  CALL_POLICY,
  CallDenialReason,
  CallErrorCode,
} from './call.constants';

/**
 * A refused call. `code` is what the client sees; `reason` is internal only,
 * so blocked and unavailable can differ in logs but not on the wire.
 */
export class CallForbiddenException extends ForbiddenException {
  constructor(
    code: CallErrorCode,
    message: string,
    readonly reason: CallDenialReason,
  ) {
    super({ message, code });
  }
}

const UNAVAILABLE_MESSAGE = "This user can't be called right now";

@Injectable()
export class CallAuthorizationService {
  private readonly logger = new Logger(CallAuthorizationService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Follow.name) private readonly followModel: Model<Follow>,
    private readonly chatService: ChatService,
  ) {}

  /**
   * Throws CallForbiddenException unless the caller may call the callee.
   * Cheapest and most absolute checks first.
   */
  async assertCanCall(callerId: string, calleeId: string): Promise<void> {
    // 1. Self-call.
    if (callerId === calleeId) {
      this.deny(
        callerId,
        calleeId,
        CallErrorCode.CannotCallSelf,
        "You can't call yourself",
        CallDenialReason.Self,
      );
    }

    // A malformed id simply isn't found, so it lands on the matching branch below.
    const ids = [callerId, calleeId].filter((id) => Types.ObjectId.isValid(id));
    const users = await this.userModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('_id isActive isBanned callingRestricted')
      .lean();
    const caller = users.find((u) => String(u._id) === callerId);
    const callee = users.find((u) => String(u._id) === calleeId);

    // 2. Caller may not call at all — a full ban or a call-specific restriction.
    //    Checked early: it is absolute, and reveals nothing about the callee.
    if (!caller || caller.isBanned || caller.callingRestricted) {
      this.deny(
        callerId,
        calleeId,
        CallErrorCode.CallingRestricted,
        'Calling is not available for your account',
        CallDenialReason.CallerRestricted,
      );
    }

    // 3. Callee exists and is active.
    if (!callee || !callee.isActive || callee.isBanned) {
      this.deny(
        callerId,
        calleeId,
        CallErrorCode.UserUnavailable,
        UNAVAILABLE_MESSAGE,
        CallDenialReason.CalleeUnavailable,
      );
    }

    // 4. Block in either direction — same source of truth as chat, and the
    //    same response as "unavailable", so a block cannot be detected.
    if (await this.chatService.isBlockedBetween(callerId, calleeId)) {
      this.deny(
        callerId,
        calleeId,
        CallErrorCode.UserUnavailable,
        UNAVAILABLE_MESSAGE,
        CallDenialReason.Blocked,
      );
    }

    // 5. Relationship requirement.
    if (
      CALL_POLICY.requireMutualFollow &&
      !(await this.isMutualFollow(callerId, calleeId))
    ) {
      this.deny(
        callerId,
        calleeId,
        CallErrorCode.NotConnected,
        'You can only call people who follow you back',
        CallDenialReason.NotConnected,
      );
    }
  }

  /** Both directions of the follow exist. Served by the unique { follower, following } index. */
  private async isMutualFollow(callerId: string, calleeId: string): Promise<boolean> {
    const caller = new Types.ObjectId(callerId);
    const callee = new Types.ObjectId(calleeId);

    const follows = await this.followModel.countDocuments({
      $or: [
        { follower: caller, following: callee },
        { follower: callee, following: caller },
      ],
    });

    return follows === 2;
  }

  private deny(
    callerId: string,
    calleeId: string,
    code: CallErrorCode,
    message: string,
    reason: CallDenialReason,
  ): never {
    this.logger.log(`Call denied ${callerId} -> ${calleeId}: ${reason}`);
    throw new CallForbiddenException(code, message, reason);
  }
}
