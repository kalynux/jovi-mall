import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import {
  CHAT_LIMITS,
  EMPTY_DOC,
  escapeTelegramHtml,
  isEmptyDoc,
  toTelegramHtml,
  truncate,
  toWhatsApp,
  type RichDoc,
} from '../../../../core/richtext';
import {
  connectionService,
  buildConnectInstructions,
  type MessagingChannel,
} from '../../../channel-connections';
/**
 * The DOMAIN `Product`, not the Mongoose `IProduct`.
 *
 * `ProductRepositoryMongo.findById` maps to the domain type, and it is the right one here
 * anyway: this service needs `title`, `slug`, `description` and `descriptionRich` — four
 * fields the mapper guarantees are present and normalised, where the document type would
 * bring 50 Mongoose members and an optional `descriptionRich` that may be `undefined`.
 */
import { Product } from '../../repositories/mappers/product.mapper';
import { getWhatsAppMessagingService } from '../../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../../whatsapp/whatsapp.service';
import { TelegramNotificationService } from '../../../telegram/services/telegram-notification.service';

/**
 * ProductShareService — the send path `core/richtext/`'s formatters were written for.
 *
 * The formatters have been complete since the structured-description work landed:
 * `toWhatsApp` and `toTelegramHtml` are asserted byte-for-byte against the vendor
 * dashboard's own fixtures. **Nothing called them.** A whole-tree scan on 2026-08-21
 * confirmed the only import outside `core/richtext/` was `escapeTelegramHtml`, used by
 * the notification renderer. This closes that.
 *
 * ── ⚠ WHO A SHARE CAN BE SENT TO — and why there is no `to` ──────────────────
 * The plan for this step specified a body of `{ channel, to? }`, with `to` an arbitrary
 * recipient. **That is not implementable on either channel**, and the two reasons are
 * different:
 *
 *   **WhatsApp** — outside the 24-hour service window only an approved `template` may be
 *   sent. `WhatsAppPolicyValidator` enforces exactly that (`policy-validator.ts:76`), and
 *   there is no product-share template. So a free-form share to somebody who has not
 *   messaged the platform in the last day is refused by the platform's own policy layer.
 *
 *   **Telegram** — the Bot API sends to a `chat_id`, and a `chat_id` only exists once that
 *   person has started the bot. There is no send-to-a-phone-number call to make.
 *
 * So the recipient is always a **connected messaging identity**: the vendor's own. They
 * receive the formatted message and forward it wherever they like — which is what a share
 * button does anyway, and is the only shape both channels actually permit.
 *
 * The alternative worth naming, so nobody re-derives it: sharing to a *customer's*
 * connection would be technically possible (they hold a `channel_connections` row) and is
 * deliberately not built. It is unsolicited outbound marketing to a person who connected
 * their account for sign-in and notifications, and it inherits the same 24-hour window
 * anyway.
 */

export type ShareChannel = Extract<MessagingChannel, 'whatsapp' | 'telegram'>;

export interface ShareTarget {
  /** The raw external id — a WhatsApp phone id or a Telegram chat id. */
  externalId: string;
  /** For display only; never the send address. */
  handle: string | null;
}

export interface ProductShareMessage {
  channel: ShareChannel;
  /** Ready to send: WhatsApp markers, or escaped Telegram HTML. */
  body: string;
  /** Telegram only — HTML must be declared, or the markup arrives as literal text. */
  parseMode: 'HTML' | 'none';
}

/**
 * The header every share carries, ahead of the description.
 *
 * Built as plain text and escaped per channel rather than as a `RichDoc`, deliberately:
 * a title and a price are not authored content and must not be run through the block
 * vocabulary, which would let a product title's stray `*` become formatting.
 */
/**
 * How much of the budget a title may take.
 *
 * ⚠ **The header must be clamped, and the description budget is not enough on its own.**
 * `Product.title` has no `maxlength` in the schema, so a 5 000-character title produces a
 * body over WhatsApp's 4 096 cap however small the description budget goes. What happens
 * then is the failure `fitFormatted` exists to prevent: `WaServiceMessage.text` hard-cuts
 * the rendered STRING, which can sever a `*` and make the client swallow the rest of the
 * message into one bold run. Clamping here keeps the cut on a plain title, where it is
 * always well-formed.
 */
const TITLE_MAX = 200;

function buildHeader(product: Product, storeSlug: string | null): string[] {
  const lines: string[] = [truncate(product.title, TITLE_MAX) as string];

  const base = process.env.STOREFRONT_URL;
  if (base && storeSlug) {
    // The canonical product URL is store-scoped, because `Product.slug` is unique
    // per VENDOR — `/products/:slug` cannot resolve two vendors owning `blue-shirt`.
    // ⚠ Under `/shop` — `/stores/…` alone is a 404 on the website (deploy-day link check,
    // 2026-09-21); `product-card.ts` and `store.config.ts` already used the real path.
    lines.push(`${base.replace(/\/+$/, '')}/shop/stores/${storeSlug}/products/${product.slug}`);
  }

  return lines;
}

export class ProductShareService {
  /**
   * Resolve where a share may go, or refuse with something the vendor can act on.
   *
   * The refusal names the channel AND carries the `/connect` instruction, because
   * "no WhatsApp connection" is only actionable if you know how to make one. That
   * instruction is built by the connections module rather than restated here — it owns
   * the command name and the bot handle.
   */
  async resolveTarget(userId: string, channel: ShareChannel): Promise<ShareTarget> {
    const connection = await connectionService.getConnection(userId, channel);

    if (!connection) {
      // ⚠ `buildConnectInstructions` returns a DTO (`{ command, botHandle, deepLink }`),
      // not a sentence — interpolating it into the message renders "[object Object]".
      // It belongs in `details`, where a client can render the deep link as a button.
      throw createAppError(
        ERROR_CODES.PRODUCT_SHARE_CHANNEL_NOT_CONNECTED,
        422,
        `No ${channel} account is connected to your profile. Connect one, then share again.`,
        { channel, howToConnect: buildConnectInstructions(channel) },
      );
    }

    return { externalId: connection.external_id, handle: connection.handle ?? null };
  }

  /**
   * Render one product as a message for one channel.
   *
   * **Pure** — no I/O, no clock — so the formatting is assertable without a database or a
   * live bot, which is the half of this feature that can actually go wrong.
   *
   * The description falls back to the plain-text `description` when no `descriptionRich`
   * exists. That is the ordinary case for every product created before structured
   * descriptions and for every client with no formatting editor: `description` stays
   * authoritative, and inventing a document from it server-side is the one thing
   * `core/richtext`'s header forbids.
   */
  render(product: Product, channel: ShareChannel, storeSlug: string | null = null): ProductShareMessage {
    const header = buildHeader(product, storeSlug);
    const doc: RichDoc = product.descriptionRich ?? EMPTY_DOC;
    const hasRich = !isEmptyDoc(doc);

    if (channel === 'whatsapp') {
      const headerText = `*${header[0]}*${header[1] ? `\n${header[1]}` : ''}`;
      // The description gets what is left of the budget after the header and the blank
      // line between them. Fitting happens on the DOCUMENT inside `toWhatsApp`; passing
      // the full cap and trimming the result afterwards is what severs a marker.
      const budget = Math.max(64, CHAT_LIMITS.MAX - headerText.length - 2);
      const description = hasRich ? toWhatsApp(doc, { maxLength: budget }) : product.description.slice(0, budget);

      return {
        channel,
        body: description ? `${headerText}\n\n${description}` : headerText,
        parseMode: 'none',
      };
    }

    const headerHtml = `<b>${escapeTelegramHtml(header[0])}</b>${header[1] ? `\n${escapeTelegramHtml(header[1])}` : ''}`;
    const budget = Math.max(64, CHAT_LIMITS.MAX - headerHtml.length - 2);
    const description = hasRich
      ? toTelegramHtml(doc, { maxLength: budget })
      : escapeTelegramHtml(product.description.slice(0, budget));

    return {
      channel,
      body: description ? `${headerHtml}\n\n${description}` : headerHtml,
      // Declared because the body IS HTML. Note this is the deliberate exception to
      // `telegram-bot.service.ts`'s `parseMode: 'none'` default — that default exists
      // because most senders interpolate unescaped user text, and everything here has
      // gone through `escapeTelegramHtml` or the formatter, which escapes as it renders.
      parseMode: 'HTML',
    };
  }
  /**
   * Send a rendered message to the vendor's own connected identity.
   *
   * ── The WhatsApp window is checked HERE rather than left to the policy layer ──
   * `WhatsAppPolicyValidator` already refuses a non-template send outside the 24-hour
   * window, so this check is not what makes the platform correct — it is what makes the
   * *refusal legible*. Reaching the policy layer produces a WhatsApp-policy error naming
   * message types; this produces "message the bot first", which is the actual remedy and
   * the only one the vendor can act on.
   *
   * There is deliberately no template fallback. The notification stacks have one because
   * a delivery update must arrive; a share is a vendor pressing a button, and inventing an
   * approved template for it would mean a Meta review cycle for a convenience feature.
   */
  async dispatch(target: ShareTarget, message: ProductShareMessage, userId: string): Promise<void> {
    if (message.channel === 'whatsapp') {
      const waPhoneId = target.externalId;
      const to = waPhoneId.startsWith('+') ? waPhoneId : `+${waPhoneId}`;

      const withinWindow = await new WhatsappService().canSendFreeMessage(waPhoneId);
      if (!withinWindow) {
        throw createAppError(
          ERROR_CODES.PRODUCT_SHARE_WINDOW_CLOSED,
          422,
          'WhatsApp only allows a free-form message within 24 hours of your last message to the bot. Send it any message, then share again.',
          { channel: 'whatsapp' },
        );
      }

      const result = await getWhatsAppMessagingService().send(
        WaServiceMessage.text({ to, body: message.body, previewUrl: true }),
      );

      if (!result.success) {
        throw createAppError(
          ERROR_CODES.PRODUCT_SHARE_SEND_FAILED,
          502,
          undefined,
          { channel: 'whatsapp', cause: result.error },
        );
      }
      return;
    }

    // Telegram resolves the chat from the user itself, so the connection lookup above is
    // the authorization ("is a channel connected") rather than the addressing.
    const sent = await new TelegramNotificationService().send({
      userId,
      message: message.body,
      parseMode: message.parseMode === 'HTML' ? 'HTML' : 'none',
    });

    if (!sent.success) {
      throw createAppError(
        ERROR_CODES.PRODUCT_SHARE_SEND_FAILED,
        502,
        undefined,
        { channel: 'telegram', cause: sent.error },
      );
    }
  }
}

export const productShareService = new ProductShareService();
