import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

import { Env } from '../../config/env';

interface SendOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Thin Nodemailer wrapper. Dev points at Mailhog (no auth, no TLS);
 * prod uses Gmail SMTP via Google Workspace (smtp.gmail.com:465 with TLS,
 * service-account or app-password credentials impersonating noreply@nockta.com).
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter!: Transporter;

  onModuleInit(): void {
    this.transporter = nodemailer.createTransport({
      host: Env.SMTP_HOST,
      port: Env.SMTP_PORT,
      secure: Env.SMTP_USE_TLS,
      ...(Env.SMTP_USER && Env.SMTP_PASSWORD
        ? { auth: { user: Env.SMTP_USER, pass: Env.SMTP_PASSWORD } }
        : {}),
    });
  }

  async send(options: SendOptions): Promise<void> {
    await this.transporter.sendMail({
      from: Env.SMTP_FROM,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html ?? `<pre style="font-family:inherit">${escapeHtml(options.text)}</pre>`,
    });
    this.logger.debug({ to: options.to, subject: options.subject }, 'mail sent');
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
