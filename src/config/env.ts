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
    return configService.get<string>('MONGODB_URI', '');
  }

  // JWT
  static get JWT_SECRET(): string {
    return configService.get<string>('JWT_SECRET', '');
  }

  static get JWT_EXPIRES_IN(): string {
    return configService.get<string>('JWT_EXPIRES_IN', '7d');
  }

  static get JWT_REFRESH_SECRET(): string {
    return configService.get<string>('JWT_REFRESH_SECRET', '');
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

  // Redis TLS (managed Redis providers need this on)
  static get REDIS_TLS(): boolean {
    const raw = configService.get<string>('REDIS_TLS', '0');
    return raw === '1' || raw === 'true';
  }

  // Firebase Cloud Messaging (push notifications)
  static get FIREBASE_PROJECT_ID(): string {
    return configService.get<string>('FIREBASE_PROJECT_ID', '');
  }

  static get FIREBASE_CLIENT_EMAIL(): string {
    return configService.get<string>('FIREBASE_CLIENT_EMAIL', '');
  }

  /** Stored single-line with literal \n escapes; callers must unescape. */
  static get FIREBASE_PRIVATE_KEY(): string {
    return configService.get<string>('FIREBASE_PRIVATE_KEY', '');
  }

  // Stream Video (calling). The key is public and shipped to the app; the
  // secret signs user tokens and verifies webhooks, and never leaves the server.
  static get STREAM_API_KEY(): string {
    return configService.get<string>('STREAM_API_KEY', '').trim();
  }

  static get STREAM_API_SECRET(): string {
    return configService.get<string>('STREAM_API_SECRET', '').trim();
  }

  static get STREAM_APP_ID(): string {
    return configService.get<string>('STREAM_APP_ID', '').trim();
  }

  // Push provider *names* as configured in the Stream dashboard. Served to the
  // app so the same binary works against any backend. The APNs one is chosen
  // per app build (sandbox for development builds, production for staging /
  // TestFlight / App Store) — not per backend environment.
  static get STREAM_APN_PROVIDER_SANDBOX(): string {
    return configService.get<string>('STREAM_APN_PROVIDER_SANDBOX', 'boostra-voip-dev').trim();
  }

  static get STREAM_APN_PROVIDER_PRODUCTION(): string {
    return configService.get<string>('STREAM_APN_PROVIDER_PRODUCTION', 'boostra-voip-prod').trim();
  }

  /**
   * Kill switch for webhook ingestion. When off, webhooks are still verified,
   * logged and acknowledged, but never change call records — for staging
   * environments pointed at a shared Stream app.
   */
  static get STREAM_WEBHOOK_ENABLED(): boolean {
    const raw = configService.get<string>('STREAM_WEBHOOK_ENABLED', 'true');
    return raw !== 'false' && raw !== '0';
  }

  /** How long a call rings before it becomes missed. Long enough to reach a phone in a pocket. */
  static get CALL_RING_TIMEOUT_SECONDS(): number {
    const n = Number(configService.get<string>('CALL_RING_TIMEOUT_SECONDS', '45'));
    return Number.isFinite(n) && n > 0 ? n : 45;
  }

  /**
   * Master switch for new calls (tokens, initiation, pre-flight). Off: those
   * return 503 CALLING_DISABLED; in-flight calls, webhooks and history keep
   * working. Defaults OFF in production so calling ships dark, ON elsewhere.
   */
  static get CALLING_ENABLED(): boolean {
    const raw = configService.get<string>('CALLING_ENABLED');
    if (raw === undefined || raw === '') return !this.IS_PRODUCTION;
    return raw === 'true' || raw === '1';
  }

  /** While CALLING_ENABLED is off, these user ids can still call (internal rollout). */
  static get CALLING_ROLLOUT_USER_IDS(): string[] {
    return configService
      .get<string>('CALLING_ROLLOUT_USER_IDS', '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  /**
   * The production Stream app's id. When set, boot refuses a mismatch: a
   * non-production backend whose key belongs to this app (staging test calls
   * would ring real users), or a production backend whose key doesn't.
   */
  static get STREAM_PRODUCTION_APP_ID(): string {
    return configService.get<string>('STREAM_PRODUCTION_APP_ID', '').trim();
  }

  /**
   * Monthly participant-minute allowance of the Stream plan. The Maker plan has
   * hard limits, so running out means calls stop working. Unset: no alert.
   */
  static get CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE(): number {
    const n = Number(configService.get<string>('CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE', '0'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Per-caller cap on call initiations in any rolling hour. */
  static get CALL_MAX_PER_HOUR(): number {
    const n = Number(configService.get<string>('CALL_MAX_PER_HOUR', '30'));
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  /**
   * Hourly answer rate below this logs an ALERT. A dead VoIP credential looks
   * exactly like a falling answer rate and is otherwise invisible.
   */
  static get CALL_ANSWER_RATE_ALERT_FLOOR(): number {
    const n = Number(configService.get<string>('CALL_ANSWER_RATE_ALERT_FLOOR', '0.4'));
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.4;
  }

  static get STREAM_FIREBASE_PROVIDER(): string {
    return configService.get<string>('STREAM_FIREBASE_PROVIDER', 'boostra-android').trim();
  }

  // Bull Queue
  static get BULL_REDIS_HOST(): string {
    return configService.get<string>('BULL_REDIS_HOST', this.REDIS_HOST);
  }

  static get BULL_REDIS_PORT(): number {
    return configService.get<number>('BULL_REDIS_PORT', this.REDIS_PORT);
  }

  // Mail: which transport initialises and sends. 'brevo' | 'smtp'
  static get MAIL_PROVIDER(): string {
    return configService
      .get<string>('MAIL_PROVIDER', 'smtp')
      .trim()
      .toLowerCase();
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
    return configService.get<string>(
      'MAIL_FROM',
      'BoostMe <no-reply@boostme.app>',
    );
  }

  // Coins: how many coins equal 1 GBP of promote budget (default 100 → 1 coin = £0.01)
  static get COINS_PER_GBP(): number {
    return Number(configService.get<string>('COINS_PER_GBP', '100'));
  }

  // Boost campaigns: qualified unique views bought per coin (500 coins × 4 = 2,000 views)
  static get BOOST_VIEWS_PER_COIN(): number {
    return Number(configService.get<string>('BOOST_VIEWS_PER_COIN', '4'));
  }

  // RevenueCat webhook Authorization header secret
  static get REVENUECAT_WEBHOOK_SECRET(): string {
    return configService.get<string>('REVENUECAT_WEBHOOK_SECRET', '');
  }

  // In-App Purchase validation (App Store / Google Play)
  static get APPLE_IAP_SHARED_SECRET(): string {
    return configService.get<string>('APPLE_IAP_SHARED_SECRET', '');
  }

  static get GOOGLE_PLAY_ACCESS_TOKEN(): string {
    return configService.get<string>('GOOGLE_PLAY_ACCESS_TOKEN', '');
  }

  static get GOOGLE_PLAY_PACKAGE_NAME(): string {
    return configService.get<string>('GOOGLE_PLAY_PACKAGE_NAME', '');
  }

  static get ALLOW_UNVERIFIED_IAP(): boolean {
    return (
      configService.get<string>('ALLOW_UNVERIFIED_IAP', 'false') === 'true'
    );
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
    return configService.get<string>('APP_NAME', 'Boostra');
  }

  static get ADMIN_EMAILS(): string[] {
    return configService
      .get<string>('ADMIN_EMAILS', '')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);
  }

  static get FRONTEND_URL(): string {
    return configService.get<string>('FRONTEND_URL', 'https://boostme.app');
  }

  // Google Sign-In: every client ID a valid ID token may be issued for. The app
  // normally requests the web audience, but a native iOS/Android flow can return
  // its own, so all three are accepted.
  static get GOOGLE_WEB_CLIENT_ID(): string {
    return configService.get<string>('GOOGLE_WEB_CLIENT_ID', '');
  }

  static get GOOGLE_IOS_CLIENT_ID(): string {
    return configService.get<string>('GOOGLE_IOS_CLIENT_ID', '');
  }

  static get GOOGLE_ANDROID_CLIENT_ID(): string {
    return configService.get<string>('GOOGLE_ANDROID_CLIENT_ID', '');
  }

  /** Audiences accepted when verifying a Google ID token. */
  static get GOOGLE_CLIENT_IDS(): string[] {
    return [
      this.GOOGLE_WEB_CLIENT_ID,
      this.GOOGLE_IOS_CLIENT_ID,
      this.GOOGLE_ANDROID_CLIENT_ID,
    ].filter(Boolean);
  }

  // Deep-link scheme for mobile reset password (expo-router)
  static get APP_DEEP_LINK_SCHEME(): string {
    // Must match `scheme` in the app's app.config.js, or reset links open nothing.
    return configService.get<string>('APP_DEEP_LINK_SCHEME', 'boostra');
  }
}
