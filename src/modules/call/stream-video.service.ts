import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StreamClient, WHEvent } from '@stream-io/node-sdk';
import { ENV } from '../../config';
import { CallErrorCode } from './call.constants';

/** The identity Stream shows to the other party (incoming-call screen, CallKit). */
export interface StreamUserProfile {
  id: string;
  name: string;
  image?: string;
}

/**
 * Whether a push provider the app will be told to use actually works:
 * `missing` / `disabled` / `not_voip` all mean calls silently won't ring.
 */
export type PushProviderState = 'ok' | 'missing' | 'disabled' | 'not_voip' | 'unknown';

export interface PushProviderCheck {
  name: string;
  state: PushProviderState;
}

/** Stream connectivity as reported by health. Safe to expose — no secrets. */
export interface StreamStatus {
  enabled: boolean;
  appId: string | null;
  reachable: boolean | null;
  responseTime: number | null;
  detail: string | null;
  checkedAt: string | null;
  push: {
    apnSandbox: PushProviderCheck;
    apnProduction: PushProviderCheck;
    firebase: PushProviderCheck;
  } | null;
}

/** Health endpoints are public and unthrottled; don't let them hammer Stream's API. */
const PROBE_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Thin wrapper over the Stream server SDK. Holds the single StreamClient for the
 * app; everything else in the call module goes through getClient().
 */
@Injectable()
export class StreamVideoService implements OnModuleInit {
  private readonly logger = new Logger(StreamVideoService.name);
  private client: StreamClient | null = null;

  private status: StreamStatus = {
    enabled: false,
    appId: null,
    reachable: null,
    responseTime: null,
    detail: null,
    checkedAt: null,
    push: null,
  };

  async onModuleInit() {
    const missing = [
      !ENV.STREAM_API_KEY && 'STREAM_API_KEY',
      !ENV.STREAM_API_SECRET && 'STREAM_API_SECRET',
    ].filter(Boolean);

    if (missing.length) {
      const detail = `Missing ${missing.join(', ')}`;
      this.status.detail = detail;

      // A silently disabled calling feature in production is worse than a failed deploy.
      if (ENV.IS_PRODUCTION) {
        throw new Error(`Stream Video is not configured: ${detail}.`);
      }
      this.logger.warn(`${detail} — calling is disabled.`);
      return;
    }

    this.client = new StreamClient(ENV.STREAM_API_KEY, ENV.STREAM_API_SECRET, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.status.enabled = true;
    this.status.appId = ENV.STREAM_APP_ID || null;
    this.logger.log(`Stream Video client ready (app ${ENV.STREAM_APP_ID || 'unknown'}).`);

    await this.verifyAppIdentity();

    // Detached: a slow or failing probe must not hold up application boot.
    void this.probe();
  }

  /**
   * Refuse to boot against the wrong Stream app — a staging backend holding
   * production credentials makes staging test calls ring real users. Checks
   * the app the *key* actually belongs to (not what config claims):
   *   - non-production + key belongs to STREAM_PRODUCTION_APP_ID → refuse
   *   - production + key belongs to any other app                → refuse
   *   - STREAM_APP_ID set but disagrees with the key's real app  → refuse
   * Skipped when STREAM_PRODUCTION_APP_ID is unset (e.g. local dev). If Stream
   * can't be reached it warns and boots: an outage must not block a deploy.
   */
  private async verifyAppIdentity(): Promise<void> {
    const productionAppId = ENV.STREAM_PRODUCTION_APP_ID;
    if (!productionAppId) {
      if (ENV.IS_PRODUCTION) {
        this.logger.error(
          'STREAM_PRODUCTION_APP_ID is not set — cannot verify this backend is on the production Stream app.',
        );
      }
      return;
    }

    let actualAppId: string;
    try {
      actualAppId = String((await this.client!.getApp()).app.id);
    } catch (err) {
      this.logger.warn(`Stream app identity not verified (unreachable): ${(err as Error).message}`);
      return;
    }

    const problem =
      ENV.STREAM_APP_ID && ENV.STREAM_APP_ID !== actualAppId
        ? `STREAM_APP_ID is ${ENV.STREAM_APP_ID} but the API key belongs to app ${actualAppId}`
        : !ENV.IS_PRODUCTION && actualAppId === productionAppId
          ? `NODE_ENV=${ENV.NODE_ENV} is using the PRODUCTION Stream app (${actualAppId}) — test calls would ring real users`
          : ENV.IS_PRODUCTION && actualAppId !== productionAppId
            ? `production is using Stream app ${actualAppId}, not the production app ${productionAppId}`
            : null;

    if (problem) {
      throw new Error(`Refusing to start: ${problem}.`);
    }
    this.logger.log(`Stream app identity verified (app ${actualAppId}).`);
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /** The shared client. Throws 503 when calling is disabled, so callers needn't check. */
  getClient(): StreamClient {
    if (!this.client) {
      throw new ServiceUnavailableException({
        message: 'Calling is not available',
        code: CallErrorCode.CallingUnavailable,
      });
    }
    return this.client;
  }

  /** The public app key. Safe to hand to clients; the secret never is. */
  getApiKey(): string {
    return this.getClient().apiKey;
  }

  /** Create or refresh the user on Stream so the other party sees a name and avatar. */
  async upsertUser(user: StreamUserProfile): Promise<void> {
    await this.upsertUsers([user]);
  }

  async upsertUsers(users: StreamUserProfile[]): Promise<void> {
    await this.getClient().upsertUsers(
      users.map((u) => ({ id: u.id, name: u.name, ...(u.image && { image: u.image }) })),
    );
  }

  /**
   * Verify a webhook's X-Signature (HMAC-SHA256 of the raw body with the API
   * secret) and parse it. Handles gzip. Throws InvalidWebhookError on a bad
   * signature or malformed body.
   */
  verifyAndParseWebhook(rawBody: Buffer, signature: string): WHEvent {
    return this.getClient().verifyAndParseWebhook(rawBody, signature);
  }

  /** How many participants are still in the call's live session. */
  async getSessionParticipantCount(streamCallId: string): Promise<number> {
    const [type, ...rest] = streamCallId.split(':');
    const res = await this.getClient().video.call(type, rest.join(':')).get();
    return res.call.session?.participants?.length ?? 0;
  }

  /**
   * End a call for everyone — stops ringing and drops both clients. For
   * administrative termination (mid-call block, moderation, ring timeout).
   * Idempotent in effect: ending an already-ended call is harmless.
   */
  async endCall(streamCallId: string): Promise<void> {
    const [type, ...rest] = streamCallId.split(':');
    await this.getClient().video.call(type, rest.join(':')).end();
  }

  /**
   * Create the call on Stream with ringing on. Stream then rings the callee's
   * devices (in-app, and VoIP/FCM push once Iteration 6 is configured).
   */
  async createRingingCall(args: {
    type: string;
    id: string;
    callerId: string;
    calleeId: string;
    video: boolean;
    custom: Record<string, unknown>;
  }): Promise<void> {
    await this.getClient()
      .video.call(args.type, args.id)
      .getOrCreate({
        ring: true,
        video: args.video,
        data: {
          created_by_id: args.callerId,
          members: [{ user_id: args.callerId }, { user_id: args.calleeId }],
          custom: args.custom,
        },
      });
  }

  /**
   * Hard-delete a user from Stream, with the calls they own there. Runs as an
   * async task on Stream's side.
   */
  async deleteUser(userId: string): Promise<void> {
    await this.getClient().deleteUsers({ user_ids: [userId], user: 'hard', calls: 'hard' });
  }

  /** Local HMAC signing — no network call. */
  generateUserToken(userId: string, validitySeconds: number): string {
    return this.getClient().generateUserToken({
      user_id: userId,
      validity_in_seconds: validitySeconds,
    });
  }

  /** Last known connectivity, re-probed when older than the cache window or when forced. */
  async getStatus(force = false): Promise<StreamStatus> {
    const age = this.status.checkedAt
      ? Date.now() - Date.parse(this.status.checkedAt)
      : Infinity;
    if (this.client && (force || age > PROBE_CACHE_MS)) {
      await this.probe();
    }
    return { ...this.status };
  }

  /** An authenticated round-trip, so bad credentials show as down — not just absent ones. */
  private async probe(): Promise<void> {
    if (!this.client) return;

    const start = Date.now();
    try {
      await this.client.getApp();
      this.status.reachable = true;
      this.status.detail = null;
      await this.checkPushProviders();
    } catch (err) {
      const wasReachable = this.status.reachable;
      this.status.reachable = false;
      this.status.detail = (err as Error).message;
      if (wasReachable !== false) {
        this.logger.error(`Stream probe failed: ${this.status.detail}`);
      }
    } finally {
      this.status.responseTime = Date.now() - start;
      this.status.checkedAt = new Date().toISOString();
    }
  }

  /**
   * Compare the provider names we hand to the app with what the Stream app
   * actually has. A mismatch is the classic "calls don't ring on locked
   * phones" failure, and it produces no error anywhere else. Informational:
   * it never marks Stream itself as down.
   */
  private async checkPushProviders(): Promise<void> {
    const expected = {
      apnSandbox: { name: ENV.STREAM_APN_PROVIDER_SANDBOX, apn: true },
      apnProduction: { name: ENV.STREAM_APN_PROVIDER_PRODUCTION, apn: true },
      firebase: { name: ENV.STREAM_FIREBASE_PROVIDER, apn: false },
    };

    let providers: {
      name: string;
      type: string;
      disabled_at?: Date;
      apn_supports_voip_notifications?: boolean;
    }[];
    try {
      providers = (await this.client!.listPushProviders()).push_providers ?? [];
    } catch (err) {
      this.logger.warn(`Could not list Stream push providers: ${(err as Error).message}`);
      const unknown = (name: string): PushProviderCheck => ({ name, state: 'unknown' });
      this.status.push = {
        apnSandbox: unknown(expected.apnSandbox.name),
        apnProduction: unknown(expected.apnProduction.name),
        firebase: unknown(expected.firebase.name),
      };
      return;
    }

    const check = ({ name, apn }: { name: string; apn: boolean }): PushProviderCheck => {
      const p = providers.find((x) => x.name === name && x.type === (apn ? 'apn' : 'firebase'));
      if (!p) return { name, state: 'missing' };
      if (p.disabled_at) return { name, state: 'disabled' };
      if (apn && !p.apn_supports_voip_notifications) return { name, state: 'not_voip' };
      return { name, state: 'ok' };
    };

    const previous = this.status.push;
    this.status.push = {
      apnSandbox: check(expected.apnSandbox),
      apnProduction: check(expected.apnProduction),
      firebase: check(expected.firebase),
    };

    // Warn on change only, so a missing provider in dev doesn't spam every probe.
    for (const [key, result] of Object.entries(this.status.push)) {
      const before = previous?.[key as keyof typeof expected]?.state;
      if (result.state !== 'ok' && result.state !== before) {
        this.logger.warn(
          `Stream push provider "${result.name}" (${key}) is ${result.state} — calls will not ring on locked devices for builds that use it.`,
        );
      }
    }
  }
}
