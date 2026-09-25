import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Call } from '../../database/schemas/call/call.schema';
import { CallService } from './call.service';
import { StreamVideoService } from './stream-video.service';
import { CallEndReason, LIVE_CALL_STATUSES } from './call.constants';

/**
 * Calling's part of account deletion.
 *
 * Retention policy: call records are KEPT — they're also the other person's
 * history, and small, useful metadata. What identifies the deleted user is
 * removed: their Stream user (and the calls they own there), their per-user
 * quality/feedback entries, and their hidden-history markers. Once the user
 * document is gone, the remaining id is an unlinkable reference, and the other
 * person's history shows "Deleted user".
 */
@Injectable()
export class CallAccountCleanupService {
  private readonly logger = new Logger(CallAccountCleanupService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<Call>,
    private readonly callService: CallService,
    private readonly streamVideo: StreamVideoService,
  ) {}

  /** Never throws: deleting the account must succeed even if this partly fails. */
  async onUserDeleted(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    const id = new Types.ObjectId(userId);

    // 1. End anything live, so the other party isn't left in a dead call.
    try {
      const live = await this.callModel
        .find({ participants: id, status: { $in: LIVE_CALL_STATUSES } })
        .select('_id status streamCallId')
        .lean();
      for (const call of live) {
        await this.callService.terminateCall(call, {
          actorId: null,
          reason: CallEndReason.AccountDeleted,
        });
      }
    } catch (err) {
      this.logger.error(`Account ${userId}: live calls not ended: ${(err as Error).message}`);
    }

    // 2. Strip their per-user data from call records.
    try {
      await this.callModel.updateMany(
        { participants: id },
        {
          $unset: {
            [`metadata.quality.${userId}`]: '',
            [`metadata.feedback.${userId}`]: '',
          },
          $pull: { hiddenFor: id },
        },
      );
    } catch (err) {
      this.logger.error(`Account ${userId}: call metadata not cleaned: ${(err as Error).message}`);
    }

    // 3. Delete them from Stream (an async task on Stream's side).
    if (this.streamVideo.isEnabled()) {
      try {
        await this.streamVideo.deleteUser(userId);
      } catch (err) {
        this.logger.error(`Account ${userId}: Stream user not deleted: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Account ${userId}: calling data cleaned up`);
  }
}
