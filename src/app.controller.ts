import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators';
import { ENV } from './config';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Minimum app version per platform, read by the app on launch and on every
   * return to the foreground. An install older than its platform's value is
   * sent to the store. Env-driven, so raising the floor needs no app release.
   */
  @Public()
  @SkipThrottle()
  @Get('app/version')
  getAppVersion() {
    return {
      ios: ENV.APP_MIN_VERSION_IOS || null,
      android: ENV.APP_MIN_VERSION_ANDROID || null,
      forceUpdate: ENV.APP_FORCE_UPDATE,
    };
  }
}
