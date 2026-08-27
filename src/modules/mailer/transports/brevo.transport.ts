import { ENV } from '../../../config';
import { MailMessage, MailTransport } from '../mail-transport.interface';

const SEND_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const ACCOUNT_ENDPOINT = 'https://api.brevo.com/v3/account';
const TIMEOUT_MS = 15_000;

/** Brevo's transactional REST API. HTTPS on 443, so an SMTP port block does not apply. */
export class BrevoTransport implements MailTransport {
  readonly name = 'Brevo';

  private apiKey = '';
  private sender = { name: '', email: '' };

  init(): void {
    const missing: string[] = [];
    if (!ENV.BREVO_API_KEY) missing.push('BREVO_API_KEY');
    if (!ENV.BREVO_SENDER_EMAIL) missing.push('BREVO_SENDER_EMAIL');

    if (missing.length) {
      throw new Error(`missing ${missing.join(' and ')}`);
    }

    this.apiKey = ENV.BREVO_API_KEY;
    this.sender = {
      name: ENV.BREVO_SENDER_NAME || ENV.APP_NAME,
      email: ENV.BREVO_SENDER_EMAIL,
    };
  }

  describe(): string {
    return `sending as "${this.sender.name}" <${this.sender.email}>`;
  }

  private headers(): Record<string, string> {
    return {
      'api-key': this.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /**
   * Confirms the key works from this host before the first real send. Catches the
   * two failures that otherwise only appear when a user is waiting on a code:
   * a bad key, and an account with IP allow-listing that excludes this server.
   */
  async verify(): Promise<string | null> {
    try {
      const res = await fetch(ACCOUNT_ENDPOINT, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return null;
      const detail = await res.text().catch(() => '');
      return `HTTP ${res.status} ${detail.slice(0, 300)}`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  async send(message: MailMessage): Promise<void> {
    const res = await fetch(SEND_ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        sender: this.sender,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // Brevo names the reason in the body: unverified sender, bad key, quota, blocked IP.
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
  }
}
