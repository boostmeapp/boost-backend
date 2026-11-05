import { Global, Module } from '@nestjs/common';
import { AppleAuthService } from './apple-auth.service';

/**
 * Global so every account-deletion path (AuthModule, UsersModule, AdminModule)
 * can revoke Apple tokens. UsersService cannot import AuthModule: AuthModule
 * already imports UsersModule.
 */
@Global()
@Module({
  providers: [AppleAuthService],
  exports: [AppleAuthService],
})
export class AppleAuthModule {}
