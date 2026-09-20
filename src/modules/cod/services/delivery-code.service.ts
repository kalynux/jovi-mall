import crypto from 'crypto';
import { WhatsAppServiceMessenger } from '../../whatsapp/services/whatsapp-service-messenger';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import { Language, templateLanguage } from '../../notifications/catalog/notification-i18n';

/**
 * DeliveryCodeService - generation, hashing and customer delivery of the COD
 * delivery code (the OTP the customer hands the agent after paying).
 *
 * The code is verified against its sha256 hash; the plaintext is persisted
 * `select: false` and surfaces ONLY through the customer's own order view, so
 * WhatsApp delivery is best-effort on top of that, never the only channel.
 *
 * Cost-minimizing send strategy: try a free-form text message first (free,
 * but only deliverable inside Meta's 24h customer-service window); only when
 * that specifically fails on the window policy do we fall back to the
 * approved `cod_delivery_code` template (costs a conversation, but works
 * anytime). Any other failure (bad number, provider outage) is logged and
 * left as-is — never retried with the paid path.
 */
export class DeliveryCodeService {
  constructor(
    private readonly whatsapp: WhatsAppServiceMessenger = new WhatsAppServiceMessenger()
  ) {}

  /** A 6-digit numeric code (crypto-random, never starts with 0). */
  generateCode(): string {
    return String(crypto.randomInt(100000, 1000000));
  }

  hashCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  /** Timing-safe comparison of a submitted code against the stored hash. */
  verifyCode(submitted: string, storedHash: string): boolean {
    const submittedHash = this.hashCode(submitted);
    const a = Buffer.from(submittedHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Best-effort WhatsApp delivery of the code to the customer. Never throws —
   * the code is always available in the customer's own order view regardless.
   *
   * `dedupeKey` must be stable for one issued code and change on regeneration
   * (e.g. `${collectionId}:${codeGeneratedAt.getTime()}`) — it seeds the
   * template send's required idempotency key.
   */
  async sendToCustomer(params: {
    customerPhone: string | null | undefined;
    code: string;
    orderNumber: string;
    expectedAmount: number;
    currency: string;
    language: Language;
    dedupeKey: string;
  }): Promise<void> {
    const { customerPhone, code, orderNumber, expectedAmount, currency, language, dedupeKey } = params;
    if (!customerPhone) return;

    const textResult = await this.whatsapp.sendText({
      to: customerPhone,
      body:
        `Your delivery code for order ${orderNumber} is *${code}*.\n\n` +
        `Amount to pay in cash on delivery: ${expectedAmount} ${currency}.\n` +
        `Only give this code to the delivery agent AFTER you have received your package and paid.`,
    });
    if (textResult.success) return;

    // Free-form text is only deliverable inside Meta's 24h customer-service
    // window. That specific failure is expected and worth paying for the
    // template fallback; anything else (bad number, provider outage, etc.)
    // is not — the code stays available in the customer's own order view.
    if (textResult.error?.code !== 'WHATSAPP_POLICY_VIOLATION') {
      console.error(
        `[DeliveryCodeService] WhatsApp text send failed for order ${orderNumber} (code stays available in the customer app):`,
        textResult.error
      );
      return;
    }

    const components: TemplateComponent[] = [
      {
        type: 'body',
        parameters: [orderNumber, code, String(expectedAmount), currency].map((text) => ({
          type: 'text' as const,
          text,
        })),
      },
    ];

    const templateResult = await getWhatsAppMessagingService().send({
      to: customerPhone,
      type: 'template',
      message: {
        type: 'template',
        name: 'cod_delivery_code',
        /**
         * ⛔ **`templateLanguage(language)`, NOT `META_LANGUAGE_CODE[language]`.** Templates
         * are approved in English and French only, so naming the customer's own language
         * asked Meta for a template that does not exist for `pt`, `es` or `ar` and the send
         * was refused.
         *
         * ⚠ **This is the path taken precisely BECAUSE the free-form text already failed** —
         * the code above only reaches here on `WHATSAPP_POLICY_VIOLATION`, meaning the
         * customer is outside the 24-hour window. So there was no third chance: for those
         * three languages the delivery code simply never arrived, and an agent turned up
         * with a parcel the customer could not confirm.
         *
         * One of six sites that carried this identical line (four notification stacks, this,
         * and phone verification — where the same defect made it impossible to verify a
         * number at all). Fallback is explicit and named; see `templateLanguage`.
         */
        language: templateLanguage(language),
        components,
      },
      meta: {
        // Templates require an idempotency key; stable per issued code, so a
        // resend (which regenerates the code) is free to send a new one.
        idempotencyKey: `cod-code:${dedupeKey}`,
      },
    });

    if (!templateResult.success) {
      console.error(
        `[DeliveryCodeService] WhatsApp template fallback also failed for order ${orderNumber} (code stays available in the customer app):`,
        templateResult.error
      );
    }
  }
}

export const deliveryCodeService = new DeliveryCodeService();
