import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import type { ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { DeviceToken } from '../../../database/schemas/notification/device-token.schema';
import { DevicePlatform, NotificationType } from '../notification.constants';

export interface SendResult {
  success: boolean;
  sentCount: number;
  failureReason?: string;
}

/**
 * Owns Firebase Admin and the FCM token store.
 *
 * Ported from the BOE backend's PushNotificationService. The differences are
 * deliberate: tokens live in their own collection rather than on a session,
 * and there is one language instead of two.
 *
 * Firebase is optional at boot. Without credentials the service logs once and
 * every send becomes a no-op, so the rest of the app — including the queue —
 * runs normally in development.
 */
@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);

  private firebaseReady = false;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(DeviceToken.name)
    private readonly deviceTokenModel: Model<DeviceToken>,
  ) {}

  onModuleInit() {
    this.initFirebase();
  }

  /* ------------------------------------------------------------------ */
  /*  Firebase Admin                                                      */
  /* ------------------------------------------------------------------ */

  private initFirebase(): void {
    if (getApps().length > 0) {
      this.firebaseReady = true;
      this.logger.log('Firebase Admin already initialized, reusing app');
      return;
    }

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');

    // Stored in .env as a single line with literal \n escapes.
    const privateKey = this.config
      .get<string>('FIREBASE_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials missing — push notifications are disabled. ' +
          'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to enable them.',
      );
      return;
    }

    try {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        } as ServiceAccount),
      });

      this.firebaseReady = true;
      this.logger.log(`Firebase Admin initialized for project ${projectId}`);
    } catch (err: any) {
      this.logger.error(`Firebase Admin init failed: ${err?.message}`);
    }
  }

  get isReady(): boolean {
    return this.firebaseReady;
  }

  /* ------------------------------------------------------------------ */
  /*  FCM token store                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Registers or refreshes a device token. Upserts on the token itself, so a
   * device that signs into a second account moves rather than duplicating.
   */
  async registerToken(
    userId: string,
    token: string,
    platform: DevicePlatform = DevicePlatform.Ios,
    appVersion?: string,
  ): Promise<{ success: boolean }> {
    if (!userId || !token?.trim()) {
      throw new Error('userId and token are required');
    }

    await this.deviceTokenModel.findOneAndUpdate(
      { token: token.trim() },
      {
        user: new Types.ObjectId(userId),
        token: token.trim(),
        platform,
        appVersion,
        isActive: true,
        lastUsedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return { success: true };
  }

  /** Deactivates one token — a single device signing out. */
  async removeToken(userId: string, token: string): Promise<{ success: boolean }> {
    if (!userId || !token?.trim()) {
      throw new Error('userId and token are required');
    }

    await this.deviceTokenModel.updateOne(
      { token: token.trim(), user: new Types.ObjectId(userId) },
      { isActive: false },
    );

    return { success: true };
  }

  /** Deactivates every token for a user — sign out of all devices. */
  async removeAllTokens(userId: string): Promise<{ success: boolean }> {
    if (!userId) throw new Error('userId is required');

    await this.deviceTokenModel.updateMany(
      { user: new Types.ObjectId(userId) },
      { isActive: false },
    );

    return { success: true };
  }

  /** Every live token for a user. */
  async getActiveTokens(userId: string): Promise<string[]> {
    if (!userId) return [];

    const rows = await this.deviceTokenModel
      .find({ user: new Types.ObjectId(userId), isActive: true })
      .select('token')
      .lean();

    return Array.from(new Set(rows.map((r) => r.token).filter(Boolean)));
  }

  /**
   * Marks tokens FCM rejected as permanently dead so they stop being retried.
   */
  private async deactivateTokens(tokens: string[]): Promise<void> {
    if (!tokens.length) return;

    await this.deviceTokenModel.updateMany(
      { token: { $in: tokens } },
      { isActive: false },
    );

    this.logger.log(`Deactivated ${tokens.length} unregistered FCM token(s)`);
  }

  /* ------------------------------------------------------------------ */
  /*  Sending                                                             */
  /* ------------------------------------------------------------------ */

  private basePayload(type: string, metadata?: Record<string, any>) {
    return {
      android: {
        priority: 'high' as const,
        notification: { sound: 'default', channelId: 'default' },
      },
      apns: {
        headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      },
      // FCM data values must be strings.
      data: {
        type: String(type),
        metadata: JSON.stringify(metadata || {}),
      },
    };
  }

  /**
   * Sends to every active device of one user.
   *
   * Returns rather than throws: the queue processor records the outcome on the
   * notification row, and a dead token is not a job failure worth retrying.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    type: NotificationType | string = NotificationType.System,
    metadata: Record<string, any> = {},
  ): Promise<SendResult> {
    if (!this.firebaseReady) {
      return { success: false, sentCount: 0, failureReason: 'firebase-disabled' };
    }

    const tokens = await this.getActiveTokens(userId);

    if (!tokens.length) {
      return { success: false, sentCount: 0, failureReason: 'no-tokens' };
    }

    try {
      const res = await getMessaging().sendEachForMulticast({
        ...this.basePayload(type, metadata),
        tokens,
        notification: { title, body },
      });

      // Prune the tokens FCM says will never work again.
      const dead: string[] = [];
      res.responses.forEach((r, i) => {
        const code = (r.error as any)?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          dead.push(tokens[i]);
        }
      });
      await this.deactivateTokens(dead);

      if (res.successCount === 0) {
        const firstError =
          res.responses.find((r) => !r.success)?.error?.message ??
          'all-sends-failed';
        this.logger.warn(`Push to user ${userId} failed: ${firstError}`);
        return { success: false, sentCount: 0, failureReason: firstError };
      }

      this.logger.log(
        `Push sent to user ${userId} (${res.successCount}/${tokens.length} device(s))`,
      );
      return { success: true, sentCount: res.successCount };
    } catch (err: any) {
      this.logger.error(`Push to user ${userId} threw: ${err?.message}`);
      return {
        success: false,
        sentCount: 0,
        failureReason: err?.message ?? 'unknown-error',
      };
    }
  }

  /**
   * Fire-and-forget send to one raw token. For manual verification only —
   * writes nothing to the database and enqueues nothing.
   */
  async sendTestToToken(
    token: string,
    title = 'Test notification',
    body = 'This is a test from the Boostra backend.',
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!token?.trim()) throw new Error('token is required');

    if (!this.firebaseReady) {
      return { success: false, error: 'Firebase is not configured' };
    }

    try {
      const messageId = await getMessaging().send({
        ...this.basePayload('Test', {}),
        token: token.trim(),
        notification: { title, body },
      });

      this.logger.log(`Test push sent, messageId: ${messageId}`);
      return { success: true, messageId };
    } catch (err: any) {
      this.logger.warn(`Test push failed: ${err?.message}`);
      return { success: false, error: err?.message ?? 'Unknown error' };
    }
  }
}
