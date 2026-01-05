import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  checks: {
    database?: HealthCheck;
    redis?: HealthCheck;
    memory?: HealthCheck;
  };
}

interface HealthCheck {
  status: 'up' | 'down';
  responseTime?: number;
  message?: string;
  details?: any;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private redisClient: Redis;
  private startTime = Date.now();

  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly configService: ConfigService,
  ) {
    // Initialize Redis client for health checks
    this.redisClient = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      db: this.configService.get('REDIS_DB', 0),
      lazyConnect: true,
      retryStrategy: () => null, // Don't retry for health checks
    });
  }

  /**
   * Check if database connection is healthy
   */
  private async checkDatabase(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const state = this.mongoConnection.readyState;
      const responseTime = Date.now() - start;

      if (state === 1) {
        return {
          status: 'up',
          responseTime,
          details: { state: 'connected' },
        };
      }

      return {
        status: 'down',
        responseTime,
        message: `Database not connected. State: ${state}`,
        details: { state },
      };
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - start,
        message: error.message,
      };
    }
  }

  /**
   * Check if Redis connection is healthy
   */
  private async checkRedis(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      await this.redisClient.connect();
      await this.redisClient.ping();
      const responseTime = Date.now() - start;

      return {
        status: 'up',
        responseTime,
      };
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - start,
        message: error.message,
      };
    } finally {
      try {
        await this.redisClient.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
    }
  }

  /**
   * Check memory usage
   */
  private checkMemory(): HealthCheck {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMemoryMB = Math.round(memUsage.rss / 1024 / 1024);

    // Consider memory unhealthy if heap usage > 90%
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    const isHealthy = heapUsagePercent < 90;

    return {
      status: isHealthy ? 'up' : 'down',
      message: isHealthy
        ? 'Memory usage normal'
        : 'Memory usage high (>90%)',
      details: {
        heapUsedMB,
        heapTotalMB,
        heapUsagePercent: Math.round(heapUsagePercent),
        rssMemoryMB,
      },
    };
  }

  /**
   * Readiness check - is the service ready to accept traffic?
   */
  async checkReadiness(): Promise<HealthCheckResult> {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
    };

    const allHealthy =
      checks.database.status === 'up' && checks.redis.status === 'up';

    return {
      status: allHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks,
    };
  }

  /**
   * Liveness check - is the service alive?
   */
  async checkLiveness(): Promise<HealthCheckResult> {
    const memory = this.checkMemory();

    return {
      status: memory.status === 'up' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks: {
        memory,
      },
    };
  }

  /**
   * Detailed health check with all dependencies
   */
  async checkDetailed(): Promise<HealthCheckResult> {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      memory: this.checkMemory(),
    };

    let status: 'ok' | 'degraded' | 'error' = 'ok';

    // Check if any critical service is down
    if (
      checks.database.status === 'down' ||
      checks.redis.status === 'down'
    ) {
      status = 'error';
    } else if (checks.memory.status === 'down') {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks,
    };
  }

  onModuleDestroy() {
    this.redisClient.disconnect();
  }
}
