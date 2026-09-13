import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ENV } from '../../config';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  picture?: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly client = new OAuth2Client();

  /**
   * Verify a Google ID token and return the identity it asserts.
   *
   * Everything here comes from Google's signed payload — never from the request
   * body — so the client cannot claim an email it does not own.
   */
  async verify(idToken: string): Promise<GoogleIdentity> {
    const audience = ENV.GOOGLE_CLIENT_IDS;

    if (!audience.length) {
      this.logger.error(
        'No GOOGLE_*_CLIENT_ID configured — Google sign-in is unavailable.',
      );
      throw new ServiceUnavailableException(
        'Google sign-in is not configured. Please use email and password.',
      );
    }

    let payload;
    try {
      // Checks the signature against Google's public keys, plus issuer,
      // expiry and that the audience is one of our own client IDs.
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Google ID token rejected: ${(err as Error).message}`);
      throw new UnauthorizedException('Google sign-in failed. Please try again.');
    }

    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('Google did not return an email address.');
    }

    // Without this, an unverified Google address could be used to claim an
    // account belonging to someone else.
    if (payload.email_verified !== true) {
      throw new UnauthorizedException(
        'Your Google email address is not verified.',
      );
    }

    return {
      googleId: payload.sub,
      email: payload.email.trim().toLowerCase(),
      firstName: payload.given_name,
      lastName: payload.family_name,
      picture: payload.picture,
    };
  }
}
