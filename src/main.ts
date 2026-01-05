import { NestFactory } from '@nestjs/core';
import { ValidationPipe, LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { ENV } from './config';
import { AllExceptionsFilter } from './common/filters';
import { LoggingInterceptor } from './common/interceptors';

async function bootstrap() {
  // Check environment before ENV init
  const isProduction = process.env.NODE_ENV === 'production';

  // Production-optimized logger configuration
  const loggerConfig: LogLevel[] = isProduction
    ? ['error', 'warn', 'log'] // Less verbose in production
    : ['error', 'warn', 'log', 'debug', 'verbose'];

  const app = await NestFactory.create(AppModule, {
    logger: loggerConfig,
    bufferLogs: true, // Buffer logs for better performance
  });

  const configService = app.get(ConfigService);
  ENV.init(configService);

  // Production-grade security headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              scriptSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'https:'],
            },
          }
        : false, // Disable CSP in development
      hsts: isProduction
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,
    }),
  );

  // Compression for responses
  app.use(
    compression({
      threshold: 1024, // Only compress responses > 1KB
      level: isProduction ? 6 : 1, // Higher compression in production
    }),
  );

  // CORS configuration - strict in production
  const corsOrigins = ENV.CORS_ORIGIN === '*' ? '*' : ENV.CORS_ORIGIN.split(',');

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // 24 hours
  });

  // Request body size limits for security
  app.use(require('express').json({ limit: '10mb' }));
  app.use(require('express').urlencoded({ limit: '10mb', extended: true }));

  app.setGlobalPrefix(ENV.API_PREFIX);

  // Global validation pipe with production settings
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // Disable detailed errors in production for security
      disableErrorMessages: isProduction,
      validationError: {
        target: !isProduction,
        value: !isProduction,
      },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global interceptors
  if (!isProduction) {
    app.useGlobalInterceptors(new LoggingInterceptor());
  }

  // Graceful shutdown hooks
  app.enableShutdownHooks();

  const port = ENV.PORT;
  await app.listen(port, '0.0.0.0'); // Listen on all interfaces for Docker

  const environment = isProduction ? '🚨 PRODUCTION' : '🛠️  DEVELOPMENT';

  console.log(`
    ✅ BoostMe API Server Started Successfully
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    🚀 Server:        http://localhost:${port}/${ENV.API_PREFIX}
    📝 Environment:   ${environment}
    🗄️  Database:      MongoDB ${isProduction ? '(Replica Set)' : ''}
    📦 Queue:         BullMQ with Redis
    🔒 Security:      Helmet + CORS + Rate Limiting
    💚 Health Check:  http://localhost:${port}/${ENV.API_PREFIX}/health
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);

  if (isProduction) {
    console.log('⚠️  Running in PRODUCTION mode - verbose logging disabled');
  }
}

bootstrap().catch((err) => {
  console.error('❌ Error starting application:', err);
  process.exit(1);
});
