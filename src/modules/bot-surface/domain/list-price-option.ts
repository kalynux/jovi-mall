import { botChromeFill } from './bot-chrome-copy';
import { listPriceActionId } from './bot-action-id';
import { formatBotPrice } from './product-card';
import type { BotReplyOption } from './channel-reply';
import { WA_LIMITS } from '../../whatsapp/constants/whatsapp-limits';

/**
 * **Buy at 7 000 XAF** — the listed price as a button, under the bargain question.
 *
 * ⭐ **This REVERSES "`bargain` gets none, deliberately"** (owner, 2026-10-17). That rule held that
 * any button beside an offer question invites a tap that means nothing. A tap on the price the
 * customer can already pay means something precise: *I'll take it as listed*. The question stays,
 * so typing an offer still starts the haggle.
 *
 * ── ⚠ WHY THIS IS NOT IN `purchase-chat-copy.ts` ─────────────────────────────
 * That module is imported by `negotiation/domain/deal-in-basket.ts`, which the deploy-day harness
 * loads into the n8n simulator. Formatting a price needs `product-card.ts`, which reaches the
 * catalogue DTOs — weight that harness has no reason to carry. So the one builder that needs a
 * price lives here, and the three doors that draw the bargain question import it.
 */

/** What the listed-price button needs to know about the variant being haggled over. */
export interface ListedPrice {
    productId: string;
    variantId: string;
    /** The DISPLAYED price — the ask on a bargainable variant (`PublicVariantDto.price`). */
    amount: number;
    currency: string;
}

/**
 * ⚠ **The price is ON the button on both channels**, for `lockInOption`'s reason: a press is an
 * acceptance only when the customer can see what they accept. WhatsApp's title cap is 20, so a
 * label that does not fit falls back to `✓ <price>` — the counter-offer button's own shape.
 *
 * Empty when the price cannot ride a token (`listPriceActionId`), never a dead button.
 */
export function listPriceActions(listed: ListedPrice, language: string | null): BotReplyOption[] {
    const id = listPriceActionId(listed.productId, listed.variantId, listed.amount);
    if (!id) return [];

    const price = formatBotPrice(listed.amount, listed.currency);
    const label = botChromeFill('buyAtPriceButton', language, { price });
    return [{
        id,
        label,
        ...(label.length > WA_LIMITS.BUTTON_REPLY_TITLE ? { shortLabel: `✓ ${price}` } : {}),
    }];
}
