import { logger } from '../../../../core/logging';
import { getWhatsAppMessagingService } from '../../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../../whatsapp/builders/service-message.builder';
import { TemplateComponent } from '../../../whatsapp/types/whatsapp-message.types';
import { TelegramNotificationService } from '../../../telegram/services/telegram-notification.service';
import { Language, templateLanguage } from '../../../notifications/catalog/notification-i18n';
import { toTelegramNotificationBody, toWhatsAppNotificationBody } from '../../../notifications/catalog/message-renderer';
import {
  LISTING_CHAT_LABEL,
  LISTING_MESSAGE_BUTTON_BASE,
  LISTING_STOP_LABEL,
  ListingMessageSituation,
  listingMessageTemplateName,
  listingStopToken,
  renderListingMessageTemplateParams,
  renderListingMessageText,
} from '../../../notifications/catalog/listing-message-catalog';
import { ProviderMessageChannel } from '../listing.types';

/**
 * Delivers ONE provider message to ONE chat (SERVICE-LISTINGS-PLAN L-15, L-16). It decides
 * nothing — consent, caps, window and charge are `ProviderMessagingService`'s — and it never
 * throws: a refused send is `{ ok: false }`, so the caller can release the claim and refund.
 *
 * Every message carries the two ways out the plan requires:
 *   - the provider's own WhatsApp (`https://wa.me/<digits>`) — where a reply goes (L-16);
 *   - "Stop messages from this business" (`lc:<vendorId>:n`, § C-3a) — the opt-out (L-14).
 *
 * WhatsApp has ONE interactive affordance per message (a CTA link OR reply buttons), so in the
 * window the chat link moves into the body as a line and the opt-out is the reply button — the
 * same trade the customer notifications make (`viewLineFor`). Outside the window only the
 * call-me template can go: the number in its text (Meta forbids a button that opens WhatsApp)
 * and the opt-out as its one quick reply.
 */
export interface ProviderMessageDelivery {
  situation: ListingMessageSituation;
  /** The `provider_customer_messages` row id — one send per row, whatever retries. */
  deliveryKey: string;
  channel: ProviderMessageChannel;
  lang: Language;
  /** The customer's user id (Telegram resolves its chat from it). */
  userId: string;
  /** The customer's WhatsApp id (digits, from their connection) — required on WhatsApp. */
  whatsappId: string | null;
  /** Is the customer inside Wi-Mall's 24-hour WhatsApp window? */
  withinWindow: boolean;
  vendorId: string;
  businessName: string;
  /** The provider's number the chat link opens (digits or E.164). */
  chatNumber: string;
  /** call-me: the number shown; free text: unused. */
  providerPhone?: string;
  /** free text: the provider's words. */
  messageBody?: string;
}

export interface ProviderMessageSendResult {
  ok: boolean;
  providerMessageId: string | null;
  /** How it went: 'text' in the window, 'template' outside it, 'telegram'. */
  via: 'text' | 'template' | 'telegram' | null;
}

const digitsOf = (v: string): string => v.replace(/\D/g, '');

export class ProviderMessageSender {
  constructor(private readonly telegram: Pick<TelegramNotificationService, 'send'> = new TelegramNotificationService()) {}

  async send(d: ProviderMessageDelivery): Promise<ProviderMessageSendResult> {
    const chatDigits = digitsOf(d.chatNumber);
    const ctx = {
      businessName: d.businessName,
      providerPhone: d.providerPhone ?? '',
      messageBody: d.messageBody ?? '',
      chatDigits,
    };
    const copy = renderListingMessageText(d.situation, d.lang, ctx);
    const chatUrl = `${LISTING_MESSAGE_BUTTON_BASE}/${chatDigits}`;
    const chatLabel = LISTING_CHAT_LABEL[d.lang] ?? LISTING_CHAT_LABEL.en;
    const stop = { token: listingStopToken(d.vendorId), label: LISTING_STOP_LABEL[d.lang] ?? LISTING_STOP_LABEL.en };

    // A free text from a listing with no phone or WhatsApp has nothing to link to; call-me
    // always has a number (the service refuses it otherwise).
    const hasChat = chatDigits.length > 0;

    try {
      if (d.channel === 'telegram') {
        const res = await this.telegram.send({
          userId: d.userId,
          message: toTelegramNotificationBody(copy.subject, copy.body),
          ...(hasChat ? { button: { label: chatLabel, url: chatUrl } } : {}),
          quickReplies: [stop],
        });
        return { ok: res.success, providerMessageId: null, via: res.success ? 'telegram' : null };
      }

      if (!d.whatsappId || !process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
        return { ok: false, providerMessageId: null, via: null };
      }
      const to = d.whatsappId.startsWith('+') ? d.whatsappId : `+${d.whatsappId}`;

      if (d.withinWindow) {
        const body = toWhatsAppNotificationBody('', hasChat ? `${copy.body}\n\n${chatLabel}: ${chatUrl}` : copy.body).trim();
        const res = await getWhatsAppMessagingService().send(
          WaServiceMessage.buttons({ to, header: copy.subject, body, buttons: [{ id: stop.token, title: stop.label }] }),
        );
        return { ok: res.success, providerMessageId: res.messageId ?? null, via: res.success ? 'text' : null };
      }

      // Outside the window only an approved template may go — call-me has one, free text never.
      const templateName = listingMessageTemplateName(d.situation);
      if (!templateName) return { ok: false, providerMessageId: null, via: null };
      const components: TemplateComponent[] = [
        {
          type: 'body',
          parameters: renderListingMessageTemplateParams(d.situation, d.lang, ctx).map((text) => ({ type: 'text' as const, text })),
        },
        // ⛔ No URL button: Meta refuses one that opens WhatsApp. The number is in the body, where
        // WhatsApp makes it tappable; the template's only button is the opt-out, at index 0.
        { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: stop.token }] },
      ];
      const res = await getWhatsAppMessagingService().send({
        to,
        type: 'template',
        message: {
          type: 'template',
          name: templateName,
          // ⛔ Approved in en + fr only — never the customer's own pt / es / ar.
          language: templateLanguage(d.lang),
          components,
        },
        meta: { idempotencyKey: `provider-message:${d.deliveryKey}:whatsapp` },
      });
      return { ok: res.success, providerMessageId: res.messageId ?? null, via: res.success ? 'template' : null };
    } catch (err) {
      logger().error({ err, vendorId: d.vendorId, channel: d.channel }, 'listings: provider message send failed');
      return { ok: false, providerMessageId: null, via: null };
    }
  }
}

export const providerMessageSender = new ProviderMessageSender();
