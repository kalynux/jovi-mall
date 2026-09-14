import fs from 'fs/promises';
import path from 'path';
import handlebars from 'handlebars';
import { SendEmailOptions, EmailType } from './mail.interface';
import { getMailProvider } from './mail.instance';
import { mailBrand } from './domain/mail-brand';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { EMAIL_FORMAT_MESSAGE, toEmailAddress } from '../../core/validation/email';

export class MailService {
  private templateCache: Map<string, HandlebarsTemplateDelegate> = new Map();

  /**
   * ⚠ **The provider is resolved per call through the singleton, not captured in a field.**
   *
   * This class is constructed with `new MailService()` at eight call sites, several of them in
   * long-lived services built once at module load. Caching the provider on the instance would
   * mean eight chains, eight copies of the failover latch, and — the part that actually breaks —
   * a latch discovered by the customer-notification handler that the password-reset service
   * knows nothing about. `getMailProvider()` is memoised, so this costs a map lookup.
   *
   * It also replaces the old two-branch `MAIL_PROVIDER === 'smtp' ? … : console` constructor,
   * which is where the provider vocabulary used to be decided. That belongs in
   * `mail.factory.ts`, the one place provider selection happens.
   */
  private get provider() {
    return getMailProvider();
  }

  /**
   * Ask the configured provider to prove it can reach its backend, sending nothing.
   *
   * Exists for `GET /system/integrations?probe=smtp` and is called from nowhere else — a
   * diagnostics-only method, and the only reason it is on the service rather than reached
   * through the private `provider` field is that `probeSmtp` must not have to break
   * encapsulation to find it. It was breaking it, via an `unknown` cast, and that is precisely
   * why the probe was broken for a whole phase.
   */
  async verify(): Promise<void> {
    await this.provider.verify();
  }

  async send(options: SendEmailOptions): Promise<void> {
    // The last gate before an address leaves the platform. Recipients reach this
    // service from stored profile fields, not from a request body, so the
    // request-time schema is not on this path — a legacy or hand-edited row with
    // a malformed address would otherwise be handed to the SMTP provider, which
    // fails opaquely (or, worse, silently drops it). Same rule as every inbound
    // endpoint: `core/validation/email`.
    const recipient = toEmailAddress(options.to);
    if (!recipient) {
      throw createAppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        `Cannot send mail: recipient address is not valid. ${EMAIL_FORMAT_MESSAGE}`,
        { field: 'to' }
      );
    }

    const html = await this.renderTemplate(options.template, options.variables);
    const from = this.getSender(options.type, options.from);

    await this.provider.sendEmail({
      to: recipient,
      from,
      subject: options.subject,
      html,
    });
  }

  private getSender(type: EmailType, override?: string): string {
    if (override) return override;

    const defaultSender = process.env.MAIL_FROM_DEFAULT || 'support@wi-mall.com';

    switch (type) {
      case 'AUTH':
        return process.env.MAIL_FROM_AUTH || 'support@wi-mall.com';
      case 'ORDER':
        return process.env.MAIL_FROM_ORDER || 'support@wi-mall.com';
      case 'SYSTEM':
        return process.env.MAIL_FROM_SYSTEM || 'support@wi-mall.com';
      default:
        return defaultSender;
    }
  }

  private async renderTemplate(templateName: string, variables: any): Promise<string> {
    await ensurePartialsRegistered();

    /**
     * ⚠ **Brand goes UNDER the caller's variables, never over them.** Spreading the caller
     * second is what keeps `{{title}}` and `{{message}}` winning while `{{brandName}}` and
     * `{{brandColor}}` are always present — see `domain/mail-brand.ts` for why no call site
     * should have to pass them. It also means `year`, which two callers do pass today, keeps
     * working unchanged rather than being fought over.
     */
    const context = { ...mailBrand(), ...variables };

    const cached = this.templateCache.get(templateName);
    if (cached) return cached(context);

    const templatePath = path.join(__dirname, 'templates', `${templateName}.hbs`);

    try {
      const source = await fs.readFile(templatePath, 'utf-8');
      const template = handlebars.compile(source);
      this.templateCache.set(templateName, template);
      return template(context);
    } catch (error) {
      console.error(`Failed to load template: ${templateName}`, error);
      throw createAppError(ERROR_CODES.MAIL_TEMPLATE_NOT_FOUND, 500, undefined, { template: templateName });
    }
  }
}

/**
 * Register the shared chrome partials — `mail-head`, `mail-foot`, `mail-button`.
 *
 * ── Why partials rather than eight copies of the layout ──────────────────────
 * Email HTML is verbose and unavoidably table-based, so the chrome is ~60 lines per template.
 * Duplicated eight times, a change to the footer address is eight edits and the ninth template
 * somebody adds next year silently keeps the old one. The partials make the chrome one file.
 *
 * ⚠ **Handlebars partials are registered GLOBALLY on the `handlebars` module**, not per
 * instance — so this must run exactly once and must be idempotent across the eight
 * `new MailService()` call sites. The promise is memoised rather than a boolean flag: two
 * concurrent first-sends would otherwise both see `false` and race on the filesystem read.
 *
 * ⚠ The directory is copied to `dist/` by `scripts/copy-build-assets.ts`, which copies
 * `modules/mail/templates` RECURSIVELY — so `partials/` comes along with no manifest entry.
 * Do not "tidy" that into a file list; a new partial would then be present under `npm run dev`
 * and absent from every container image, which is the exact split that file exists to close.
 */
let partialsPromise: Promise<void> | null = null;

function ensurePartialsRegistered(): Promise<void> {
  if (!partialsPromise) {
    partialsPromise = (async () => {
      const dir = path.join(__dirname, 'templates', 'partials');
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.hbs')) continue;
        const source = await fs.readFile(path.join(dir, entry), 'utf-8');
        handlebars.registerPartial(entry.replace(/\.hbs$/, ''), source);
      }
    })().catch((error) => {
      // Reset, so a transient filesystem failure does not poison every later send with a
      // rejected promise nobody can retry.
      partialsPromise = null;
      throw error;
    });
  }
  return partialsPromise;
}
