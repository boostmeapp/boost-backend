import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FollowsModule } from './modules/follows/follows.module';
import { FeedModule } from './modules/feed/feed.module';
import { AdminModule } from './modules/admin/admin.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { PaymentModule } from './modules/payment/payment.module';
import { BoostModule } from './modules/boost/boost.module';
import { RewardModule } from './modules/reward/reward.module';
import { UploadModule } from './modules/upload/upload.module';
import { VideoModule } from './modules/video/video.module';
import { StripeConnectModule } from './modules/stripe-connect/stripe-connect.module';
import { PayoutModule } from './modules/payout/payout.module';
import { HealthModule } from './modules/health/health.module';
import { JwtAuthGuard } from './common/guards';
import { AllExceptionsFilter } from './common/filters';
import { ENV } from './config';
import { CommentsModule } from './modules/comments/comments.module';
import { SearchModule } from './modules/search/search/search.module';

@Module({
  imports: [
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: '.env',
})
,
    ScheduleModule.forRoot(),
    // Rate Limiting for Production
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        ENV.init(configService);
        return [{
          ttl: configService.get('THROTTLE_TTL', 60) * 1000, // Convert to ms
          limit: configService.get('THROTTLE_LIMIT', ENV.IS_PRODUCTION ? 100 : 1000),
        }];
      },
      inject: [ConfigService],
    }),
    // BullMQ with Production Settings
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        ENV.init(configService);
        const isProduction = ENV.IS_PRODUCTION;

        return {
          redis: {
            host: configService.get('REDIS_HOST', 'localhost'),
            port: configService.get('REDIS_PORT', 6379),
            password: configService.get('REDIS_PASSWORD'),
            db: configService.get('REDIS_DB', 0),
            // Bull-specific settings (no enableReadyCheck or maxRetriesPerRequest)
            maxRetriesPerRequest: null, // Disable for Bull compatibility
            enableReadyCheck: false, // Disable for Bull compatibility
            connectTimeout: 10000,
          },
          defaultJobOptions: {
            removeOnComplete: isProduction ? 100 : 50,
            removeOnFail: isProduction ? 500 : 100,
            attempts: isProduction ? 5 : 3,
            backoff: {
              type: 'exponential',
              delay: isProduction ? 10000 : 5000,
            },
            timeout: 120000, // 2 minutes
          },
          settings: {
            maxStalledCount: 3,
            stallInterval: 30000,
            lockDuration: 30000,
          },
        };
      },
      inject: [ConfigService],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    FollowsModule,
    FeedModule,
    WalletModule,
    TransactionModule,
    PaymentModule,
    BoostModule,
    CommentsModule,
    SearchModule,
    RewardModule,
    UploadModule,
    VideoModule,
    StripeConnectModule,
    PayoutModule,
    HealthModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Rate limiting guard (applies first)
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Auth guard (applies after throttler)
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
