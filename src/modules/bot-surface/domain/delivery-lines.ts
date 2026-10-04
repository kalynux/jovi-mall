import type { DeliveryPayer, VendorDeliveryTermsMode } from '../../vendors/domain/delivery-terms';
import { botChrome, botChromeFill } from './bot-chrome-copy';
import { formatBotPrice } from './product-card';

/**
 * ⭐ **THE DELIVERY LINE(S) OF A BOT CHECKOUT — and the shop's terms on a product card.**
 * (ADR-A11, customer-paid delivery, 2026-10-04.)
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Until ADR-A11 delivery was free to every customer on every order, so no bot surface ever drew a
 * delivery line: the total WAS the items. A shop may now charge delivery (`never`, `above` a
 * basket amount, or the 30% cap's fallback — D-6), so the chat review, the Telegram checkout page
 * (`co.html`) and the order screen each need one more line — and three hand-written copies of "is
 * this free, and how much more makes it free" are three chances to disagree with the charge.
 *
 * ── ⚠ NO ARITHMETIC HERE, AND NONE ON A PAGE ────────────────────────────────
 * Every number comes from the cart quote (`CartQuoteService`, the function checkout prices with):
 * `perVendor[].delivery` (what the customer pays for that shop) and `freeDelivery.shortfall` (how
 * much more from that shop makes it free). This file FORMATS them and picks the words — it adds
 * nothing up, and the total stays `quote.total`, formatted by the caller. `co.html` renders the
 * strings built here through `textContent` and computes nothing (`test:delivery-surfaces`).
 *
 * Pure: no clock, no database, no `await`.
 */

/** The cart-quote fields a delivery line reads — a structural subset of `CartQuoteVendorLine`. */
export interface QuoteDeliveryFacts {
    vendorId: string;
    /** What the CUSTOMER pays for this shop's delivery (0 when the shop pays). */
    delivery: number;
    /** `null` for a digital-only shop — nothing ships, so there is no line. */
    deliveryPayer: DeliveryPayer | null;
    freeDelivery: { mode: VendorDeliveryTermsMode; freeAboveAmount: number | null; shortfall: number | null } | null;
}

/** One shop's delivery, worded and formatted. */
export interface BotDeliveryLine {
    vendorId: string;
    /** `Delivery` (one shop ships) or `Delivery · <shop>` (several). */
    label: string;
    /** The formatted amount, or "Free". */
    valueText: string;
    /** `label: value`, in the customer's language — a chat message line. */
    text: string;
    /** "Add X more from <shop> and delivery is free." — non-blocking; `null` when not applicable. */
    hint: string | null;
    /** The customer pays something for this shop's delivery. */
    charged: boolean;
}

/** A WhatsApp interactive body is 1 024 characters; a shop name must not eat it. */
const SHOP_CLIP = 60;

function clip(value: string, max: number): string {
    const text = value.trim();
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One line per shop that SHIPS, in quote order.
 *
 * @param shopNames vendor id → Store name (`null`/absent → "This shop").
 */
export function deliveryLinesOf(
    perVendor: readonly QuoteDeliveryFacts[],
    currency: string,
    shopNames: ReadonlyMap<string, string | null>,
    language: string | null | undefined,
): BotDeliveryLine[] {
    const shipping = perVendor.filter((line) => line.deliveryPayer !== null);
    const oneShop = shipping.length === 1;

    return shipping.map((line) => {
        const named = shopNames.get(line.vendorId)?.trim();
        const shop = named ? clip(named, SHOP_CLIP) : botChrome('checkoutThisShop', language);
        const label = oneShop
            ? botChrome('checkoutDeliveryLabel', language)
            : botChromeFill('checkoutDeliveryShopLabel', language, { shop });
        const charged = line.delivery > 0;
        const valueText = charged ? formatBotPrice(line.delivery, currency) : botChrome('checkoutDeliveryFree', language);

        /**
         * ⚠ The hint only when the customer is actually paying AND a positive amount from this shop
         * would make it free. `shortfall` is the quote's (null when no basket size can make it free,
         * or the shop never delivers free) — never re-derived from `freeAboveAmount` here.
         */
        const shortfall = line.freeDelivery?.shortfall ?? null;
        const hint = charged && typeof shortfall === 'number' && shortfall > 0
            ? oneShop
                ? botChromeFill('checkoutFreeDeliveryHintOneShop', language, { amount: formatBotPrice(shortfall, currency) })
                : botChromeFill('checkoutFreeDeliveryHint', language, { amount: formatBotPrice(shortfall, currency), shop })
            : null;

        return {
            vendorId: line.vendorId,
            label,
            valueText,
            text: botChromeFill('checkoutDeliveryLine', language, { label, value: valueText }),
            hint,
            charged,
        };
    });
}

/**
 * The shop's delivery terms as one card / detail line — defined beside the card it is drawn on
 * (`product-card.ts`) and re-exported here so every delivery wording has one index.
 */
export { deliveryTermsLine } from './product-card';

/** "Incl. 1 500 XAF delivery" under an order group's total — `null` when the customer paid none. */
export function deliveryIncludedLine(
    delivery: number,
    currency: string,
    language: string | null | undefined,
): string | null {
    if (!(delivery > 0)) return null;
    return botChromeFill('orderDeliveryIncluded', language, { amount: formatBotPrice(delivery, currency) });
}
