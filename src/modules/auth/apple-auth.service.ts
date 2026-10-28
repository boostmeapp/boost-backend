import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createPublicKey, JsonWebKey, KeyObject } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ENV } from '../../config';

const APPLE_ISSUER = 'https://appleid.apple.com';
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
// A kid we have not seen means Apple rotated keys; refetch, but not on every
// request a forged kid could trigger.
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
// Token exchange and revoke run on the sign-in and deletion paths; never let a
// slow Apple hold those up.
const APPLE_REQUEST_TIMEOUT_MS = 10 * 1000;

export interface AppleIdentity {
  appleId: string;
  /** Absent on some repeat sign-ins; the appleId lookup covers those. */
  email?: string;
  isPrivateEmail: boolean;
}

/** Apple sends some boolean claims as the strings "true"/"false". */
const isTrue = (v: unknown) => v === true || v === 'true';

@Injectable()
export class AppleAuthService {
  private readonly logger = new Logger(AppleAuthService.name);
  private keys = new Map<string, KeyObject>();
  private keysFetchedAt = 0;

  /**
   * Verify an Apple identity token and return the identity it asserts.
   *
   * Everything here comes from Apple's signed payload — never from the request
   * body. `rawNonce` is what the app generated; Apple was given its SHA-256, so
   * the token carries the hash and a token replayed from another sign-in fails.
   */
  async verify(
    identityToken: string,
    rawNonce: string,
  ): Promise<AppleIdentity> {
    const audience = ENV.APPLE_CLIENT_IDS;

    if (!audience.length) {
      this.logger.error(
        'No APPLE_BUNDLE_ID configured — Apple sign-in is unavailable.',
      );
      throw new ServiceUnavailableException(
        'Apple sign-in is not configured. Please use email and password.',
      );
    }

    let payload: jwt.JwtPayload;
    try {
      // Checks the signature against Apple's public keys, plus issuer,
      // expiry and that the audience is one of our own client IDs.
      payload = await new Promise<jwt.JwtPayload>((resolve, reject) =>
        jwt.verify(
          identityToken,
          (header, cb) => {
            void this.signingKey(header.kid)
              .then((key) => cb(null, key))
              .catch((err: Error) => cb(err));
          },
          {
            algorithms: ['RS256'],
            issuer: APPLE_ISSUER,
            audience: audience as [string, ...string[]],
          },
          (err, decoded) =>
            err || !decoded || typeof decoded === 'string'
              ? reject(err ?? new Error('Malformed token'))
              : resolve(decoded),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Apple identity token rejected: ${(err as Error).message}`,
      );
      throw new UnauthorizedException(
        'Apple sign-in failed. Please try again.',
      );
    }

    const expectedNonce = createHash('sha256').update(rawNonce).digest('hex');
    if (!payload.sub || payload.nonce !== expectedNonce) {
      this.logger.warn(
        'Apple identity token rejected: missing sub or nonce mismatch',
      );
      throw new UnauthorizedException(
        'Apple sign-in failed. Please try again.',
      );
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : undefined;

    // Same rule as Google: an unverified address must never claim an account.
    if (email && !isTrue(payload.email_verified)) {
      throw new UnauthorizedException(
        'Your Apple email address is not verified.',
      );
    }

    return {
      appleId: payload.sub,
      email,
      isPrivateEmail: isTrue(payload.is_private_email),
    };
  }

  /**
   * Swap the single-use authorization code for a refresh token, kept only so it
   * can be revoked when the account is deleted. Null on any failure.
   */
  async exchangeCode(code: string): Promise<string | null> {
    if (!this.canCallApple) return null;
    try {
      const clientId = ENV.APPLE_BUNDLE_ID;
      const res = await this.post('/auth/token', {
        client_id: clientId,
        client_secret: this.clientSecret(clientId),
        code,
        grant_type: 'authorization_code',
      });
      if (!res.ok) {
        this.logger.warn(
          `Apple code exchange failed: ${res.status} ${await res.text()}`,
        );
        return null;
      }
      const data = (await res.json()) as { refresh_token?: string };
      return data.refresh_token ?? null;
    } catch (err) {
      this.logger.warn(`Apple code exchange failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Revoke our Sign in with Apple tokens. App Review requires this when the
   * user deletes their account (Guideline 5.1.1(v)). Never throws: the
   * deletion must succeed even if Apple is unreachable.
   */
  async revoke(refreshToken: string): Promise<void> {
    if (!this.canCallApple) return;
    try {
      const clientId = ENV.APPLE_BUNDLE_ID;
      const res = await this.post('/auth/revoke', {
        client_id: clientId,
        client_secret: this.clientSecret(clientId),
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });
      if (!res.ok) {
        this.logger.warn(`Apple revoke failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(`Apple revoke failed: ${(err as Error).message}`);
    }
  }

  /** Token endpoints need the .p8 key; without it, exchange/revoke are skipped. */
  private get canCallApple(): boolean {
    return !!(ENV.APPLE_SIGNIN_KEY_ID && ENV.APPLE_SIGNIN_PRIVATE_KEY);
  }

  /** Short-lived ES256 client secret Apple requires on /auth/token and /auth/revoke. */
  private clientSecret(clientId: string): string {
    return jwt.sign({}, ENV.APPLE_SIGNIN_PRIVATE_KEY, {
      algorithm: 'ES256',
      keyid: ENV.APPLE_SIGNIN_KEY_ID,
      issuer: ENV.APPLE_TEAM_ID,
      audience: APPLE_ISSUER,
      subject: clientId,
      expiresIn: '5m',
    });
  }

  private post(path: string, form: Record<string, string>): Promise<Response> {
    return fetch(`${APPLE_ISSUER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS),
    });
  }

  /** Apple's public key for `kid`, from a key set refreshed daily. */
  private async signingKey(kid?: string): Promise<KeyObject> {
    if (!kid) throw new Error('Token has no key id');

    const age = Date.now() - this.keysFetchedAt;
    if (
      age > KEYS_TTL_MS ||
      (!this.keys.has(kid) && age > UNKNOWN_KID_REFETCH_MS)
    ) {
      await this.refreshKeys();
    }

    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown Apple key id ${kid}`);
    return key;
  }

  private async refreshKeys(): Promise<void> {
    const res = await fetch(`${APPLE_ISSUER}/auth/keys`);
    if (!res.ok) throw new Error(`Apple keys request failed: ${res.status}`);

    const { keys } = (await res.json()) as {
      keys: (JsonWebKey & { kid: string })[];
    };
    this.keys = new Map(
      keys.map((jwk) => [
        jwk.kid,
        createPublicKey({ key: jwk, format: 'jwk' }),
      ]),
    );
    this.keysFetchedAt = Date.now();
  }
}
