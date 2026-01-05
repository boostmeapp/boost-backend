import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { Public } from '../../common/decorators/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('health')
@SkipThrottle() // Health checks should not be rate limited
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Basic health check - returns OK if service is running
   * Use this for basic uptime monitoring
   */
  @Public()
  @Get()
  async check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe - checks if service is ready to accept traffic
   * Checks: Database, Redis connections
   * Use this for Kubernetes readiness probes
   */
  @Public()
  @Get('ready')
  async ready() {
    return this.healthService.checkReadiness();
  }

  /**
   * Liveness probe - checks if service is alive and not stuck
   * Use this for Kubernetes liveness probes
   */
  @Public()
  @Get('live')
  async live() {
    return this.healthService.checkLiveness();
  }

  /**
   * Detailed health check with all dependencies
   * Includes: Database, Redis, BullMQ queue status
   */
  @Public()
  @Get('detailed')
  async detailed() {
    return this.healthService.checkDetailed();
  }
}
