import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ENV } from '../../config';

export interface IapValidationResult {
  valid: boolean;
  transactionId: string;
  productId: string;
  environment: 'production' | 'sandbox' | 'unverified';
}

const APPLE_PROD = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

/**
 * Server-side validation of App Store / Google Play purchase receipts.
 *
 * Never trust the client that a purchase succeeded — the app sends the receipt/
 * token, and we verify it with Apple/Google before activating a Boost.
 *
 * Config (env):
 *  - APPLE_IAP_SHARED_SECRET   : App Store shared secret (App-Specific)
 *  - GOOGLE_PLAY_ACCESS_TOKEN  : OAuth token for Play Developer API (or wire a
 *                                service account later)
 *  - GOOGLE_PLAY_PACKAGE_NAME  : android package name
 *  - ALLOW_UNVERIFIED_IAP=true : accept without verifying (SANDBOX/DEV ONLY)
 */
@Injectable()
export class IapValidationService {
  private readonly logger = new Logger(IapValidationService.name);
  private readonly fetchFn: any = (globalThis as any).fetch;

  async validate(
    platform: 'ios' | 'android',
    receiptOrToken: string,
    expectedProductId?: string,
  ): Promise<IapValidationResult> {
    if (!receiptOrToken) {
      throw new BadRequestException('Missing purchase receipt/token');
    }

    if (platform === 'ios') {
      return this.validateApple(receiptOrToken, expectedProductId);
    }
    return this.validateGoogle(receiptOrToken, expectedProductId);
  }

  // ── Apple ─────────────────────────────────────────────────────────────
  private async validateApple(
    receipt: string,
    expectedProductId?: string,
  ): Promise<IapValidationResult> {
    const sharedSecret = ENV.APPLE_IAP_SHARED_SECRET;

    if (!sharedSecret) {
      return this.unverifiedOrThrow('Apple shared secret not configured', expectedProductId);
    }

    const body = {
      'receipt-data': receipt,
      password: sharedSecret,
      'exclude-old-transactions': true,
    };

    let res = await this.postJson(APPLE_PROD, body);
    // 21007 = sandbox receipt sent to production → retry sandbox
    if (res?.status === 21007) {
      res = await this.postJson(APPLE_SANDBOX, body);
    }

    if (res?.status !== 0) {
      throw new BadRequestException(`Apple receipt invalid (status ${res?.status})`);
    }

    const items: any[] =
      res.latest_receipt_info || res.receipt?.in_app || [];
    const match = expectedProductId
      ? items.find((i) => i.product_id === expectedProductId)
      : items[items.length - 1];

    if (!match) {
      throw new BadRequestException('Purchase not found in Apple receipt');
    }

    return {
      valid: true,
      transactionId: match.transaction_id,
      productId: match.product_id,
      environment: res.environment === 'Sandbox' ? 'sandbox' : 'production',
    };
  }

  // ── Google ────────────────────────────────────────────────────────────
  private async validateGoogle(
    purchaseToken: string,
    expectedProductId?: string,
  ): Promise<IapValidationResult> {
    const accessToken = ENV.GOOGLE_PLAY_ACCESS_TOKEN;
    const pkg = ENV.GOOGLE_PLAY_PACKAGE_NAME;

    if (!accessToken || !pkg || !expectedProductId) {
      return this.unverifiedOrThrow(
        'Google Play credentials not configured',
        expectedProductId,
      );
    }

    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}` +
      `/purchases/products/${expectedProductId}/tokens/${purchaseToken}`;

    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new BadRequestException(`Google purchase invalid (${res.status})`);
    }
    const data = await res.json();
    // purchaseState 0 = purchased
    if (data.purchaseState !== undefined && data.purchaseState !== 0) {
      throw new BadRequestException('Google purchase not in purchased state');
    }

    return {
      valid: true,
      transactionId: data.orderId || purchaseToken,
      productId: expectedProductId,
      environment: data.purchaseType === 0 ? 'sandbox' : 'production',
    };
  }

  private async postJson(url: string, body: any): Promise<any> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /**
   * When credentials are absent: allow only if explicitly enabled (sandbox/dev),
   * otherwise fail closed.
   */
  private unverifiedOrThrow(
    reason: string,
    expectedProductId?: string,
  ): IapValidationResult {
    if (ENV.ALLOW_UNVERIFIED_IAP) {
      this.logger.warn(`IAP not verified (${reason}) — accepting (ALLOW_UNVERIFIED_IAP)`);
      return {
        valid: true,
        transactionId: `unverified_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
        productId: expectedProductId || 'unknown',
        environment: 'unverified',
      };
    }
    throw new BadRequestException(
      `Purchase could not be verified: ${reason}`,
    );
  }
}
