export enum MailProvider {
  BREVO = 'brevo',
  SMTP = 'smtp',
}

/** A file sent with the message. `content` is base64-encoded. */
export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

/** Diagnostic snapshot. Never carries the API key or SMTP password. */
export interface MailStatus {
  provider: string;
  transport: string | null;
  configured: boolean;
  config: string | null;
  verified: boolean | null;
  detail: string | null;
  checkedAt: string | null;
}

export interface MailTransport {
  readonly name: string;

  /** Validate config and build the client. Throws with a readable reason when unusable. */
  init(): void;

  /** One-line summary of the active configuration, for the boot log. */
  describe(): string;

  /** Optional connectivity probe, run detached at boot. Resolves to null when healthy. */
  verify?(): Promise<string | null>;

  send(message: MailMessage): Promise<void>;
}
