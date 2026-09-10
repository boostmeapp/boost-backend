import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ENV } from '../../config';
import { MailProvider, MailStatus, MailTransport } from './mail-transport.interface';
import { BrevoTransport } from './transports/brevo.transport';
import { SmtpTransport } from './transports/smtp.transport';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);

  /** The one transport MAIL_PROVIDER selected. Null when unusable — never a silent swap. */
  private transport: MailTransport | null = null;

  private status: MailStatus = {
    provider: '',
    transport: null,
    configured: false,
    config: null,
    verified: null,
    detail: null,
    checkedAt: null,
  };

  onModuleInit() {
    const requested = ENV.MAIL_PROVIDER;
    this.status.provider = requested;

    const candidate = this.build(requested);
    if (!candidate) {
      const detail =
        `MAIL_PROVIDER="${requested}" is not recognised. Valid values: ` +
        `${Object.values(MailProvider).join(', ')}.`;
      this.status.detail = detail;
      this.logger.error(`${detail} Emails will not be sent.`);
      return;
    }

    this.status.transport = candidate.name;

    try {
      candidate.init();
    } catch (err) {
      const detail =
        `${candidate.name} is not configured: ${(err as Error).message}`;
      this.status.detail = detail;
      this.logger.error(
        `MAIL_PROVIDER=${requested} selected but ${detail}. Emails will not be sent.`,
      );
      return;
    }

    this.transport = candidate;
    this.status.configured = true;
    this.status.config = candidate.describe();
    this.logger.log(`Mail provider: ${candidate.name} — ${candidate.describe()}`);

    // Detached: a slow or failing probe must not hold up application boot.
    void this.probe(candidate);
  }

  /** Current transport and its last known health. Safe to expose — no secrets. */
  getStatus(): MailStatus {
    return { ...this.status };
  }

  /** Re-run the connectivity probe on demand, so a fix can be confirmed without a restart. */
  async revalidate(): Promise<MailStatus> {
    if (this.transport) await this.probe(this.transport);
    return this.getStatus();
  }

  private build(provider: string): MailTransport | null {
    switch (provider) {
      case MailProvider.BREVO:
        return new BrevoTransport();
      case MailProvider.SMTP:
        return new SmtpTransport();
      default:
        return null;
    }
  }

  private async probe(transport: MailTransport): Promise<void> {
    if (!transport.verify) return;

    const problem = await transport.verify();
    this.status.verified = !problem;
    this.status.detail = problem;
    this.status.checkedAt = new Date().toISOString();

    if (problem) {
      this.logger.error(`${transport.name} verify FAILED: ${problem}`);
    } else {
      this.logger.log(`${transport.name} verified — ready to send emails.`);
    }
  }

  private async send({ to, subject, html, text }: SendArgs): Promise<void> {
    const textBody = text || stripHtml(html);

    if (this.transport) {
      try {
        await this.transport.send({ to, subject, html, text: textBody });
        this.logger.log(`Email sent to ${to} (${subject}) via ${this.transport.name}`);
        return;
      } catch (err) {
        this.logger.error(
          `${this.transport.name} send failed for ${to}: ${(err as Error).message}`,
        );
      }
    }

    // Undelivered. The dev fallback prints the body so a local run can read the
    // code; in production that body is a one-time code in plaintext in the logs,
    // so only the failure is recorded.
    if (ENV.IS_PRODUCTION) {
      this.logger.error(
        `[MAIL:UNDELIVERED] to=${to} subject="${subject}" — ${this.transport ? 'send failed' : 'no provider configured'}`,
      );
    } else {
      this.logger.warn(`[MAIL:FALLBACK] to=${to} subject="${subject}"\n${textBody}`);
    }
  }

  async sendVerificationOtp(to: string, otp: string, name?: string) {
    await this.send({
      to,
      subject: `${ENV.APP_NAME} — Verify your email`,
      html: otpTemplate({
        title: 'Verify your email',
        intro: `Hi${name ? ' ' + name : ''}, welcome to ${ENV.APP_NAME}!`,
        message:
          'Use the verification code below to confirm your email address. The code expires in 10 minutes.',
        otp,
      }),
    });
  }

  async sendPasswordResetLink(to: string, resetUrl: string, otp: string) {
    await this.send({
      to,
      subject: `${ENV.APP_NAME} — Reset your password`,
      html: resetTemplate({
        resetUrl,
        otp,
      }),
    });
  }

  async sendAccountDeletionOtp(to: string, otp: string) {
    await this.send({
      to,
      subject: `${ENV.APP_NAME} — Confirm account deletion`,
      html: otpTemplate({
        title: 'Confirm account deletion',
        intro: 'We received a request to delete your account.',
        message:
          'If this was you, enter the code below in the app to permanently delete your account. The code expires in 15 minutes. If this was not you, change your password immediately.',
        otp,
        danger: true,
      }),
    });
  }

  async sendPasswordChangedNotice(to: string) {
    await this.send({
      to,
      subject: `${ENV.APP_NAME} — Your password was changed`,
      html: noticeTemplate({
        title: 'Password changed',
        message:
          'Your account password has just been changed. If you did not do this, reset your password and contact support immediately.',
      }),
    });
  }

  /**
   * Deliver a support request to the ADMIN_EMAILS inbox. Returns false when
   * there is nowhere to send it, so the caller can tell the user honestly.
   */
  async sendSupportRequest(args: {
    type: 'report' | 'contact';
    category: string;
    message: string;
    fromEmail: string;
    fromName?: string;
    userId: string;
  }): Promise<boolean> {
    const recipients = ENV.ADMIN_EMAILS;
    if (!recipients.length) {
      this.logger.error(
        '[SUPPORT] ADMIN_EMAILS is empty — support request could not be delivered.',
      );
      return false;
    }
    if (!this.transport) {
      this.logger.error('[SUPPORT] No mail transport configured.');
      return false;
    }

    const heading = args.type === 'report' ? 'Problem report' : 'Support enquiry';
    const subject = `${ENV.APP_NAME} ${heading}: ${args.category}`;
    const html = supportTemplate({
      heading,
      category: args.category,
      message: args.message,
      fromEmail: args.fromEmail,
      fromName: args.fromName,
      userId: args.userId,
    });
    const text = stripHtml(html);

    // One send per recipient: a single bad address must not lose the rest.
    const results = await Promise.all(
      recipients.map(async (to) => {
        try {
          await this.transport!.send({ to, subject, html, text });
          this.logger.log(`Support request sent to ${to} (${subject})`);
          return true;
        } catch (err) {
          this.logger.error(
            `[SUPPORT] send failed for ${to}: ${(err as Error).message}`,
          );
          return false;
        }
      }),
    );

    return results.some(Boolean);
  }

  /**
   * Email a user their own data export as a PDF. Returns false when the
   * transport cannot deliver it, so the caller can say so.
   */
  async sendDataExport(
    to: string,
    pdf: Buffer,
    name?: string,
  ): Promise<boolean> {
    if (!this.transport) {
      this.logger.error('[EXPORT] No mail transport configured.');
      return false;
    }

    const filename = `boostra-data-export-${new Date().toISOString().slice(0, 10)}.pdf`;
    const html = noticeTemplate({
      title: 'Your data export',
      message:
        `Hi${name ? ' ' + name : ''}, your ${ENV.APP_NAME} data export is attached. ` +
        'It lists your profile, videos, comments and account activity. ' +
        'Open the attached PDF to read it. ' +
        'If you did not request this, please change your password.',
    });

    try {
      await this.transport.send({
        to,
        subject: `${ENV.APP_NAME} — Your data export`,
        html,
        text: stripHtml(html),
        attachments: [
          {
            filename,
            content: pdf.toString('base64'),
            contentType: 'application/pdf',
          },
        ],
      });
      this.logger.log(`Data export sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(
        `[EXPORT] send failed for ${to}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async sendAccountDeletedNotice(to: string) {
    await this.send({
      to,
      subject: `${ENV.APP_NAME} — Your account has been deleted`,
      html: noticeTemplate({
        title: 'Account deleted',
        message:
          'Your account and associated data have been removed. We are sorry to see you go.',
      }),
    });
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shell(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0F1C22;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#E6EEF2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0F1C22;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#152832;border-radius:14px;padding:32px;">
        <tr><td>
          <div style="font-size:22px;font-weight:700;color:#00D1FF;margin-bottom:24px;">${ENV.APP_NAME}</div>
          ${body}
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #25404C;font-size:12px;color:#7A8A92;">
            You are receiving this email because of an action on your ${ENV.APP_NAME} account.
            If you did not request this, you can safely ignore it.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function otpTemplate(args: {
  title: string;
  intro: string;
  message: string;
  otp: string;
  danger?: boolean;
}): string {
  const accent = args.danger ? '#FF4D6D' : '#00D1FF';
  return shell(`
    <h2 style="font-size:20px;color:#FFFFFF;margin:0 0 12px;">${args.title}</h2>
    <p style="margin:0 0 8px;color:#C4D0D6;">${args.intro}</p>
    <p style="margin:0 0 20px;color:#A0AAB0;">${args.message}</p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;padding:18px 28px;background:#0F1C22;border:1px solid ${accent};border-radius:10px;font-size:32px;font-weight:700;letter-spacing:10px;color:${accent};">${args.otp}</div>
    </div>
  `);
}

function resetTemplate(args: { resetUrl: string; otp: string }): string {
  return shell(`
    <h2 style="font-size:20px;color:#FFFFFF;margin:0 0 12px;">Reset your password</h2>
    <p style="margin:0 0 16px;color:#C4D0D6;">Tap the button below to choose a new password. This link expires in 30 minutes.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${args.resetUrl}" style="display:inline-block;padding:14px 28px;background:#00D1FF;color:#0F1C22;font-weight:700;text-decoration:none;border-radius:10px;">Reset password</a>
    </div>
    <p style="margin:0 0 8px;color:#A0AAB0;font-size:13px;">Or use this 6-digit code in the app:</p>
    <div style="text-align:center;margin:8px 0 16px;">
      <div style="display:inline-block;padding:12px 20px;background:#0F1C22;border:1px solid #00D1FF;border-radius:10px;font-size:22px;font-weight:700;letter-spacing:8px;color:#00D1FF;">${args.otp}</div>
    </div>
    <p style="margin:0;color:#7A8A92;font-size:12px;word-break:break-all;">If the button doesn't work, paste this URL into your browser:<br/>${args.resetUrl}</p>
  `);
}

function supportTemplate(args: {
  heading: string;
  category: string;
  message: string;
  fromEmail: string;
  fromName?: string;
  userId: string;
}): string {
  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#7A8A92;font-size:13px;white-space:nowrap;">${label}</td>
      <td style="padding:6px 0;color:#E6EEF2;font-size:13px;">${escapeHtml(value)}</td>
    </tr>`;

  return shell(`
    <h2 style="font-size:20px;color:#FFFFFF;margin:0 0 16px;">${args.heading}</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      ${row('Category', args.category)}
      ${row('From', args.fromName ? `${args.fromName} <${args.fromEmail}>` : args.fromEmail)}
      ${row('User ID', args.userId)}
    </table>
    <div style="padding:16px;background:#0F1C22;border:1px solid #25404C;border-radius:10px;color:#C4D0D6;white-space:pre-wrap;">${escapeHtml(args.message)}</div>
    <p style="margin:20px 0 0;color:#7A8A92;font-size:12px;">Reply directly to ${escapeHtml(args.fromEmail)} to respond to this user.</p>
  `);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function noticeTemplate(args: { title: string; message: string }): string {
  return shell(`
    <h2 style="font-size:20px;color:#FFFFFF;margin:0 0 12px;">${args.title}</h2>
    <p style="margin:0;color:#C4D0D6;">${args.message}</p>
  `);
}
