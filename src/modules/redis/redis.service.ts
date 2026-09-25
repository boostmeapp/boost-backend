import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/**
 * Thin ioredis wrapper, ported from the BOE backend.
 *
 * Bull manages its own connections via BullModule.forRootAsync in AppModule —
 * this client is for everything else: health checks, counters, and any cache
 * keys a feature wants. Keys are namespaced by environment so a shared Redis
 * instance cannot have dev traffic stomp on staging.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  private client: Redis;
  private isConnected = false;
  private envPrefix: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('REDIS_HOST', '127.0.0.1');
    const port = Number(this.configService.get<string>('REDIS_PORT', '6379'));
    const password = this.configService.get<string>('REDIS_PASSWORD', '');
    const db = Number(this.configService.get<string>('REDIS_DB', '0'));

    const tlsRaw = this.configService.get<string>('REDIS_TLS', '0');
    const tlsEnabled = tlsRaw === '1' || tlsRaw === 'true';

    const options: RedisOptions = {
      host,
      port,
      password: password || undefined,
      db,
      tls: tlsEnabled ? {} : undefined,
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 1000, 5000),
      maxRetriesPerRequest: null,
    };

    this.client = new Redis(options);

    this.envPrefix = this.configService
      .get<string>('NODE_ENV', 'dev')
      .substring(0, 3);

    this.client.on('connect', () => {
      this.isConnected = true;
      this.logger.log(
        `Redis connected → ${host}:${port} (db ${db}, TLS: ${tlsEnabled})`,
      );
    });

    this.client.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });

    this.client.on('reconnecting', (delay: number) => {
      this.logger.warn(`Redis reconnecting in ${delay}ms...`);
    });
  }

  getConnection(): Redis {
    return this.client;
  }

  /** True once a connection has been established at least once. */
  get connected(): boolean {
    return this.isConnected;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  private getEnvKey(key: string): string {
    if (!key) return key;
    return key.startsWith(this.envPrefix) ? key : `${this.envPrefix}:${key}`;
  }

  async setValue(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    const envKey = this.getEnvKey(key);
    if (ttlSeconds) await this.client.set(envKey, value, 'EX', ttlSeconds);
    else await this.client.set(envKey, value);
  }

  async getValue(key: string): Promise<string | null> {
    return this.client.get(this.getEnvKey(key));
  }

  async delValue(key: string): Promise<number> {
    return this.client.del(this.getEnvKey(key));
  }

  /**
   * SET NX EX: true only for the first caller within the TTL. The building
   * block for "once per window" dedupe and throttles.
   */
  async setIfAbsent(key: string, ttlSeconds: number, value = '1'): Promise<boolean> {
    const res = await this.client.set(this.getEnvKey(key), value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  /** INCR with the TTL set on first increment — a fixed-window counter. */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const envKey = this.getEnvKey(key);
    const count = await this.client.incr(envKey);
    if (count === 1) await this.client.expire(envKey, ttlSeconds);
    return count;
  }

  /**
   * Delete only if the key still holds `value`. Releases a lock taken with
   * setIfAbsent without ever deleting one that expired and was re-taken.
   */
  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    const res = await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this.getEnvKey(key),
      value,
    );
    return res === 1;
  }

  async existsKey(key: string): Promise<boolean> {
    return (await this.client.exists(this.getEnvKey(key))) === 1;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      this.isConnected = false;
      await this.client.quit();
      this.logger.log('Redis connection closed');
    }
  }
}
