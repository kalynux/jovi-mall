import crypto from 'crypto';
import { WhatsAppServiceMessenger } from '../../whatsapp/services/whatsapp-service-messenger';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import { Language, templateLanguage } from '../../notifications/catalog/notification-i18n';
import { ORDER_DETAILS_LABEL } from '../../notifications/catalog/customer-notification-catalog';
import { toTelegramNotificationBody } from '../../notifications/catalog/message-renderer';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { MailService } from '../../mail/mail.service';
import { connectionService } from '../../channel-connections';
import { orderActionId } from '../../bot-surface/domain/bot-action-id';
import {
  DELIVERY_CODE_TEMPLATE_NAME,
  deliveryCodeBody,
  deliveryCodeSubject,
  deliveryCodeTemplateComponents,
} from '../domain/delivery-code-copy';

/**
 * The customer this code goes to — the fields the notification channel rule reads, plus the
 * language. Structural so the COD module does not import the Customer model's document type.
 */
export interface DeliveryCodeRecipient {
  _id: { toString(): string };
  user_id: { toString(): string };
  name?: string;
  email?: string | null;
  email_verified?: boolean;
}

/** Picks the one channel, by the SAME rule every customer notification uses. */
export interface NotificationChannelChooser {
  notificationChannelFor(customer: DeliveryCodeRecipient): Promise<'telegram' | 'email' | 'whatsapp' | 'push' | null>;
}

/**
 * DeliveryCodeService - generation, hashing and customer delivery of the COD
 * delivery code (the OTP the customer hands the agent after paying).
 *
 * The code is verified against its sha256 hash; the plaintext is persisted
 * `select: false` and surfaces ONLY through the customer's own order view, so
 * chat delivery is best-effort on top of that, never the only channel.
 *
 * ── WHERE IT GOES (owner's ruling, 2026-09-27) ────────────────────────────────
 * **Only to the channel set up for the customer's notifications** — Telegram, email or
 * WhatsApp, one of them, chosen by the notification stack's own rule. It used to go to
 * WhatsApp alone, addressed from `Customer.phone`, so a Telegram-only customer never received
 * their code in chat at all.
 *
 * ── ON WHATSAPP: free-form first, the template only when the window refuses ─────
 * Inside Meta's 24h customer-service window a free message is free, so it is tried first. Only
 * when THAT fails on the window policy (`WHATSAPP_POLICY_VIOLATION`) is the AUTHENTICATION
 * template `wi_mall_delivery_code` sent — it costs a conversation but works at any time, and
 * carries the code alone (`delivery-code-copy.ts` says why). The same path serves the agent's
 * resend: a reissued code comes back through `notifyCodeIssued`. Any other
 * failure (bad number, provider outage) is logged and left: never retried on the paid path.
 *
 * ⛔ **The code is a CREDENTIAL, so this path NEVER calls `noteSentToChat`** (the bot's
 * `recentlySent` record, which lands in an AI prompt and then in an n8n execution log), and
 * writes no inbox row. Keep it that way: the tap it offers is "Order details", which carries
 * only the order id.
 */
export class DeliveryCodeService {
  constructor(
    private readonly whatsapp: WhatsAppServiceMessenger = new WhatsAppServiceMessenger(),
    private readonly telegram: TelegramNotificationService = new TelegramNotificationService(),
    private readonly mail: MailService = new MailService(),
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
   * Best-effort delivery of the code on the customer's notification channel. Never throws —
   * the code is always available in the customer's own order view regardless.
   *
   * `dedupeKey` must be stable for one issued code and change on regeneration
   * (e.g. `${collectionId}:${codeGeneratedAt.getTime()}`) — it seeds the
   * template send's required idempotency key.
   *
   * Returns the channel it went out on, or null — for logs and tests, never for a decision.
   */
  async sendToCustomer(params: {
    customer: DeliveryCodeRecipient | null | undefined;
    channels: NotificationChannelChooser;
    code: string;
    orderId: string;
    orderNumber: string;
    expectedAmount: number;
    currency: string;
    language: Language;
    dedupeKey: string;
  }): Promise<'telegram' | 'email' | 'whatsapp' | null> {
    const { customer, channels, code, orderId, orderNumber, expectedAmount, currency, language, dedupeKey } = params;
    if (!customer) return null;

    const values = { orderNumber, code, amount: String(expectedAmount), currency };
    const subject = deliveryCodeSubject(language);
    const body = deliveryCodeBody(language, values);
    const orderDetails = { token: orderActionId(orderId), label: ORDER_DETAILS_LABEL[language] ?? ORDER_DETAILS_LABEL.en };

    const channel = await channels.notificationChannelFor(customer);

    if (channel === 'telegram') {
      const result = await this.telegram.send({
        userId: customer.user_id.toString(),
        message: toTelegramNotificationBody(subject, body),
        quickReplies: [orderDetails],
        parseMode: 'HTML',
      });
      if (!result.success) {
        console.error(`[DeliveryCodeService] Telegram send failed for order ${orderNumber} (code stays available in the customer app):`, result.error);
        return null;
      }
      return 'telegram';
    }

    if (channel === 'email') {
      if (!customer.email || !customer.email_verified) return null;
      await this.mail.send({
        to: customer.email,
        subject,
        template: 'customer-notification',
        type: 'SYSTEM',
        variables: { customerName: customer.name, title: subject, message: body, actionLabel: null, actionUrl: null },
      });
      return 'email';
    }

    if (channel === 'whatsapp') {
      return (await this.sendWhatsApp(customer, subject, body, values, orderDetails, language, dedupeKey)) ? 'whatsapp' : null;
    }

    return null;
  }

  private async sendWhatsApp(
    customer: DeliveryCodeRecipient,
    subject: string,
    body: string,
    values: { orderNumber: string; code: string; amount: string; currency: string },
    orderDetails: { token: string; label: string },
    language: Language,
    dedupeKey: string,
  ): Promise<boolean> {
    // The address comes from the connections store — the same one every notification uses —
    // never from `Customer.phone`.
    const connection = await connectionService.getConnection(customer.user_id.toString(), 'whatsapp');
    if (!connection) return false;
    const to = connection.external_id.startsWith('+') ? connection.external_id : `+${connection.external_id}`;

    const freeResult = await getWhatsAppMessagingService().send(
      WaServiceMessage.buttons({
        to,
        header: subject,
        body,
        buttons: [{ id: orderDetails.token, title: orderDetails.label }],
      }),
    );
    if (freeResult.success) return true;

    if (freeResult.error?.code !== 'WHATSAPP_POLICY_VIOLATION') {
      console.error(
        `[DeliveryCodeService] WhatsApp send failed for order ${values.orderNumber} (code stays available in the customer app):`,
        freeResult.error
      );
      return false;
    }

    /**
     * The AUTHENTICATION template (`delivery-code-copy.ts` says why it is that category): the code
     * as the body's one parameter and again as the copy button's. ⚠ `sub_type: 'url'` on the copy
     * button is correct — Meta compiles COPY_CODE to a URL button, as phone verification records.
     */
    const components: TemplateComponent[] = deliveryCodeTemplateComponents(values.code);

    const templateResult = await getWhatsAppMessagingService().send({
      to,
      type: 'template',
      message: {
        type: 'template',
        name: DELIVERY_CODE_TEMPLATE_NAME,
        /**
         * ⛔ **`templateLanguage(language)`, NOT `META_LANGUAGE_CODE[language]`.** Templates
         * are approved in English and French only, so naming the customer's own language
         * asked Meta for a template that does not exist for `pt`, `es` or `ar` and the send
         * was refused — and this path is reached precisely because the free message already
         * failed, so there is no third chance. Fallback is explicit and named; see
         * `templateLanguage`.
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
        `[DeliveryCodeService] WhatsApp template fallback also failed for order ${values.orderNumber} (code stays available in the customer app):`,
        templateResult.error
      );
      return false;
    }
    return true;
  }
}

export const deliveryCodeService = new DeliveryCodeService();
