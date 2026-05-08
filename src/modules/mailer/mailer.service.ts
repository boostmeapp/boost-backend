import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ENV } from '../../config';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter | null = null;

  onModuleInit() {
    if (!ENV.SMTP_HOST) {
      this.logger.warn(
        'SMTP_HOST not configured — emails will be logged only (dev mode).',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: ENV.SMTP_HOST,
      port: ENV.SMTP_PORT,
      secure: ENV.SMTP_SECURE,
      auth:
        ENV.SMTP_USER && ENV.SMTP_PASSWORD
          ? { user: ENV.SMTP_USER, pass: ENV.SMTP_PASSWORD }
          : undefined,
    });
  }

  private async send({ to, subject, html, text }: SendArgs): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`[MAIL:DEV] to=${to} subject="${subject}"\n${text || html}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: ENV.MAIL_FROM,
        to,
        subject,
        html,
        text: text || stripHtml(html),
      });
      this.logger.log(`Email sent to ${to} (${subject})`);
    } catch (err) {
      this.logger.error(`Failed to send mail to ${to}`, err as Error);
      throw err;
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

function noticeTemplate(args: { title: string; message: string }): string {
  return shell(`
    <h2 style="font-size:20px;color:#FFFFFF;margin:0 0 12px;">${args.title}</h2>
    <p style="margin:0;color:#C4D0D6;">${args.message}</p>
  `);
}
