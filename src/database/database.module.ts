import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ENV } from '../config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        ENV.init(configService);
        const isProduction = ENV.IS_PRODUCTION;

        return {
          uri: ENV.MONGODB_URI,
          // Production-grade connection options
          maxPoolSize: isProduction ? 100 : 10,
          minPoolSize: isProduction ? 10 : 2,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
          connectTimeoutMS: 10000,

          // Auto-reconnect settings
          retryWrites: true,
          retryReads: true,

          // Write concern for data safety
          w: isProduction ? 'majority' : 1,

          // Read preference for scaling
          readPreference: isProduction ? 'secondaryPreferred' : 'primary',

          // Automatic index creation (disable in production after initial setup)
          autoIndex: !isProduction,

          // Connection naming for monitoring
          appName: `boostme-${ENV.NODE_ENV}`,
        };
      },
      inject: [ConfigService],
    }),
  ],
})
export class DatabaseModule {}
