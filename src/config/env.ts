import { ConfigService } from '@nestjs/config';

let configService: ConfigService;

export class ENV {
  static init(service: ConfigService) {
    configService = service;
  }

  static get NODE_ENV(): string {
    return configService.get<string>('NODE_ENV', 'development');
  }

  static get IS_PRODUCTION(): boolean {
    return this.NODE_ENV === 'production';
  }

  static get IS_DEVELOPMENT(): boolean {
    return this.NODE_ENV === 'development';
  }

  // Server
  static get PORT(): number {
    return configService.get<number>('PORT', 3000);
  }

  // Database
  static get MONGODB_URI(): string {
    return configService.get<string>(
      'MONGODB_URI',
      ''
    );
  }

  // JWT
  static get JWT_SECRET(): string {
    return configService.get<string>(
      'JWT_SECRET',
      ''
    );
  }

  static get JWT_EXPIRES_IN(): string {
    return configService.get<string>('JWT_EXPIRES_IN', '7d');
  }

  static get JWT_REFRESH_SECRET(): string {
    return configService.get<string>(
      'JWT_REFRESH_SECRET',
      ''
    );
  }

  static get JWT_REFRESH_EXPIRES_IN(): string {
    return configService.get<string>('JWT_REFRESH_EXPIRES_IN', '30d');
  }

  // CORS
  static get CORS_ORIGIN(): string {
    return configService.get<string>('CORS_ORIGIN', '*');
  }

  // API
  static get API_PREFIX(): string {
    return configService.get<string>('API_PREFIX', 'api');
  }

  static get API_VERSION(): string {
    return configService.get<string>('API_VERSION', 'v1');
  }

  // AWS S3
  static get AWS_REGION(): string {
    return configService.get<string>('AWS_REGION', 'us-east-1');
  }

  static get AWS_ACCESS_KEY_ID(): string {
    return configService.get<string>('AWS_ACCESS_KEY_ID', '');
  }

  static get AWS_SECRET_ACCESS_KEY(): string {
    return configService.get<string>('AWS_SECRET_ACCESS_KEY', '');
  }

  static get AWS_S3_BUCKET(): string {
    return configService.get<string>('AWS_S3_BUCKET', 'boostme-videos');
  }

  static get AWS_CLOUDFRONT_DOMAIN(): string {
    return configService.get<string>('AWS_CLOUDFRONT_DOMAIN', '');
  }

  // Redis
  static get REDIS_HOST(): string {
    return configService.get<string>('REDIS_HOST', 'localhost');
  }

  static get REDIS_PORT(): number {
    return configService.get<number>('REDIS_PORT', 6379);
  }

  static get REDIS_PASSWORD(): string {
    return configService.get<string>('REDIS_PASSWORD', '');
  }

  static get REDIS_DB(): number {
    return configService.get<number>('REDIS_DB', 0);
  }

  // Bull Queue
  static get BULL_REDIS_HOST(): string {
    return configService.get<string>('BULL_REDIS_HOST', this.REDIS_HOST);
  }

  static get BULL_REDIS_PORT(): number {
    return configService.get<number>('BULL_REDIS_PORT', this.REDIS_PORT);
  }

  static get VIDEO_CHUNK_DURATION(): number {
    return configService.get<number>('VIDEO_CHUNK_DURATION', 4); // 4 seconds
  }

  static get VIDEO_QUALITIES(): string[] {
    return configService
      .get<string>('VIDEO_QUALITIES', '360p,720p,1080p')
      .split(',');
  }

  // SMTP / Mail
  static get SMTP_HOST(): string {
    return configService.get<string>('SMTP_HOST', '');
  }

  static get SMTP_PORT(): number {
    return Number(configService.get<string>('SMTP_PORT', '587'));
  }

  static get SMTP_SECURE(): boolean {
    return configService.get<string>('SMTP_SECURE', 'false') === 'true';
  }

  static get SMTP_USER(): string {
    return configService.get<string>('SMTP_USER', '');
  }

  static get SMTP_PASSWORD(): string {
    return configService.get<string>('SMTP_PASSWORD', '');
  }

  static get MAIL_FROM(): string {
    return configService.get<string>('MAIL_FROM', 'BoostMe <no-reply@boostme.app>');
  }

  // Brevo (HTTP email API — works where outbound SMTP is blocked, e.g. Render)
  static get BREVO_API_KEY(): string {
    return configService.get<string>('BREVO_API_KEY', '');
  }

  static get BREVO_SENDER_EMAIL(): string {
    return configService.get<string>('BREVO_SENDER_EMAIL', '');
  }

  static get BREVO_SENDER_NAME(): string {
    return configService.get<string>('BREVO_SENDER_NAME', this.APP_NAME);
  }

  static get APP_NAME(): string {
    return configService.get<string>('APP_NAME', 'BoostMe');
  }

  static get FRONTEND_URL(): string {
    return configService.get<string>('FRONTEND_URL', 'https://boostme.app');
  }

  // Deep-link scheme for mobile reset password (expo-router)
  static get APP_DEEP_LINK_SCHEME(): string {
    return configService.get<string>('APP_DEEP_LINK_SCHEME', 'boostme');
  }
}
