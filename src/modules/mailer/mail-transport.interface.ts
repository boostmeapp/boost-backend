export enum MailProvider {
  BREVO = 'brevo',
  SMTP = 'smtp',
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
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
