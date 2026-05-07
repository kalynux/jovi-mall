import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { ConsoleMailProvider } from './providers/console.provider';
import { SmtpMailProvider } from './providers/smtp.provider';
import { IMailProvider, SendEmailOptions, EmailType } from './mail.interface';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

export class MailService {
  private provider: IMailProvider;
  private templateCache: Map<string, HandlebarsTemplateDelegate> = new Map();

  constructor() {
    const providerType = process.env.MAIL_PROVIDER || 'console';
    if (providerType === 'smtp') {
      this.provider = new SmtpMailProvider();
    } else {
      this.provider = new ConsoleMailProvider();
    }
  }

  async send(options: SendEmailOptions): Promise<void> {
    const html = await this.renderTemplate(options.template, options.variables);
    const from = this.getSender(options.type, options.from);

    await this.provider.sendEmail({
      to: options.to,
      from,
      subject: options.subject,
      html,
    });
  }

  private getSender(type: EmailType, override?: string): string {
    if (override) return override;

    const defaultSender = process.env.MAIL_FROM_DEFAULT || 'noreply@jovimall.com';

    switch (type) {
      case 'AUTH':
        return process.env.MAIL_FROM_AUTH || 'auth@jovimall.com';
      case 'ORDER':
        return process.env.MAIL_FROM_ORDER || 'orders@jovimall.com';
      case 'SYSTEM':
        return process.env.MAIL_FROM_SYSTEM || 'system@jovimall.com';
      default:
        return defaultSender;
    }
  }

  private async renderTemplate(templateName: string, variables: any): Promise<string> {
    if (this.templateCache.has(templateName)) {
      return this.templateCache.get(templateName)!(variables);
    }

    const templatePath = path.join(__dirname, 'templates', `${templateName}.hbs`);

    try {
      const source = await fs.readFile(templatePath, 'utf-8');
      const template = handlebars.compile(source);
      this.templateCache.set(templateName, template);
      return template(variables);
    } catch (error) {
      console.error(`Failed to load template: ${templateName}`, error);
      throw createAppError(ERROR_CODES.MAIL_TEMPLATE_NOT_FOUND, 500, undefined, { template: templateName });
    }
  }
}
