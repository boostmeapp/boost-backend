import * as nodemailer from 'nodemailer';
import { ENV } from '../../../config';
import { MailMessage, MailTransport } from '../mail-transport.interface';

export class SmtpTransport implements MailTransport {
  readonly name = 'SMTP';

  private transporter: nodemailer.Transporter | null = null;
  private from = '';

  init(): void {
    if (!ENV.SMTP_HOST) {
      throw new Error('missing SMTP_HOST');
    }

    this.from =
      ENV.MAIL_FROM || `${ENV.APP_NAME} <${ENV.SMTP_USER || 'no-reply@boostme.app'}>`;

    this.transporter = nodemailer.createTransport({
      host: ENV.SMTP_HOST,
      port: ENV.SMTP_PORT,
      secure: ENV.SMTP_SECURE,
      auth:
        ENV.SMTP_USER && ENV.SMTP_PASSWORD
          ? { user: ENV.SMTP_USER, pass: ENV.SMTP_PASSWORD }
          : undefined,
      // Fail fast instead of hanging when the host blocks outbound SMTP.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  describe(): string {
    return `${ENV.SMTP_HOST}:${ENV.SMTP_PORT} as ${ENV.SMTP_USER || '(no auth)'}`;
  }

  async verify(): Promise<string | null> {
    if (!this.transporter) return 'transporter not initialised';
    try {
      await this.transporter.verify();
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) throw new Error('transporter not initialised');

    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
