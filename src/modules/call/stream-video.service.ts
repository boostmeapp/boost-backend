import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StreamClient } from '@stream-io/node-sdk';
import { ENV } from '../../config';

/** Stream connectivity as reported by health. Safe to expose — no secrets. */
export interface StreamStatus {
  enabled: boolean;
  appId: string | null;
  reachable: boolean | null;
  responseTime: number | null;
  detail: string | null;
  checkedAt: string | null;
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
  };

  onModuleInit() {
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

    // Detached: a slow or failing probe must not hold up application boot.
    void this.probe();
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /** The shared client. Throws 503 when calling is disabled, so callers needn't check. */
  getClient(): StreamClient {
    if (!this.client) {
      throw new ServiceUnavailableException('Calling is not available');
    }
    return this.client;
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
}
