import nodemailer from 'nodemailer';
import { IMailProvider, ProviderSendOptions } from '../mail.interface';

export class SmtpMailProvider implements IMailProvider {
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false, 
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  /**
   * `transporter.verify()` — EHLO plus AUTH, and nothing sent.
   *
   * This is the one genuinely side-effect-free probe among the platform's integrations, and
   * until Phase 15 it did not exist: `probeSmtp` looked for it, did not find it, and reported
   * an error every time. The consequence was that a broken SMTP configuration was discovered
   * on a customer's verification email rather than on an operator's dashboard.
   */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async sendEmail(options: ProviderSendOptions): Promise<void> {
    await this.transporter.sendMail({
      from: options.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }
}
