import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { User } from '../../database/schemas/user/user.schema';
import { displayName } from '../../common/utils/display-name.util';
import { StreamVideoService } from './stream-video.service';
import { CallErrorCode, STREAM_TOKEN_VALIDITY_SECONDS } from './call.constants';

export interface StreamTokenResponse {
  apiKey: string;
  token: string;
  userId: string;
  expiresAt: string;
}

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(private readonly streamVideo: StreamVideoService) {}

  /**
   * The auth bridge: a Boostra user gets a Stream token for themselves. Also the
   * narrowest choke point for revoking calling access.
   */
  async issueToken(user: User): Promise<StreamTokenResponse> {
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
      await this.streamVideo.upsertUser({
        id: userId,
        name: displayName(user, 'Boostra user'),
        image: user.profileImage || undefined,
      });
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
    };
  }
}
