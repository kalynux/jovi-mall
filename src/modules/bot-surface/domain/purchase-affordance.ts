import { BotChromeKey } from './bot-chrome-copy';

/**
 * WHICH purchase button a product gets — one control, four possible words.
 *
 * ── WHY THIS IS ONE DECISION IN ONE PLACE ───────────────────────────────────
 * Before this file, `product-card.ts` made a narrower version of the same call inline:
 *
 *     const buyable = item.type !== 'service' ? defaultVariantId : null;
 *
 * …and that line exists because of a defect found live rather than reasoned: a bookable yoga
 * class rendered with a working-looking "Add to cart" button, and every tap came back
 * `400 CART_SERVICE_PRODUCT_NOT_ALLOWED`. The customer read it as the shop being broken.
 *
 * The same question is now asked by four more surfaces — the chat card, the in-app listing,
 * the in-app detail screen, and the slash-command answer. Four copies of a rule whose failure
 * is invisible until somebody taps is four chances to reproduce that defect, so it is resolved
 * **once, server-side**, and every surface renders whatever it is handed.
 *
 * ⚠ **The in-app detail screen must render this verbatim and hardcode no button logic of its
 * own.** It is the seam where two workstreams meet — one owns the screen, another owns what
 * the button does — and the only way both can finish is if the screen is told, never asked.
 *
 * ── THE LADDER ──────────────────────────────────────────────────────────────
 * Each rung mirrors a rule `CartService.addToCart` already enforces
 * (`cart/services/cart.service.ts:159-203`), which is the point: a button must never offer
 * an action the cart is going to refuse.
 *
 *   1. negotiable, and not a service  → **Bargain**
 *   2. physical                       → **Add to cart**
 *   3. digital                        → **Buy now**
 *   4. service                        → **Book**
 *
 * ⚠ **Rung 1 carries a guard the product owner's wording did not: `&& not a service`.** The
 * ladder was specified as "bargain wins over everything", and it does — everywhere a bargain
 * can actually be *spent*. A won bargain becomes a price lock, and a price lock is redeemed by
 * adding a cart line; the cart refuses services outright, so a bargained service would have
 * nowhere to land. Offering the haggle and then failing to honour it is worse than not
 * offering it. In practice this is unreachable — a bargain window is vendor-configured on
 * stock-keeping variants — but an unreachable branch that fails safe costs nothing, and the
 * alternative is a dead end nobody would find until a vendor tried it.
 *
 * ⚠ **Digital gets "Buy now" rather than "Add to cart" on purpose.** The cart caps digital at
 * quantity 1 and permits exactly one digital item at a time, and a cart may not mix digital
 * with physical. A basket that can only ever hold the one thing is a step, not a basket.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No clock, no database, no environment. It decides the word and the verb; it never mints a
 * token, never reads a price and never talks to the cart.
 */

/** The action a purchase button performs. Each is a token verb in `bot-action-id.ts`. */
export type PurchaseVerb = 'bargain' | 'add' | 'buy' | 'book';

export interface PurchaseAffordance {
    verb: PurchaseVerb;
    /** The chrome key to render. Translated at render time, never here. */
    labelKey: BotChromeKey;
    /**
     * Can this button do anything at all right now?
     *
     * ⚠ **A disabled affordance is still an affordance, and callers must not treat it as
     * absent.** A chat renderer drops the button (a control that answers an error is worse
     * than no control — `channel-reply.ts` already degrades this way); an in-app screen draws
     * it greyed with the reason beside it, because a screen has room to explain and a chat
     * bubble does not. Returning the verb either way is what lets the two differ.
     */
    enabled: boolean;
}

/** What the ladder needs to know. Deliberately not a DTO — three surfaces feed it. */
export interface PurchaseAffordanceInput {
    type: 'physical' | 'digital' | 'service';
    /** `PublicProductListItemDto.negotiable`, or the chosen variant's. */
    negotiable: boolean;
    inStock: boolean;
    /**
     * The variant a cart line would name. Null on a listing row whose default variant was
     * archived, and null on every service.
     *
     * ⚠ **A service needs none and is still enabled.** Booking names a product and a slot,
     * never a variant, so requiring one here would disable every service on the platform —
     * which is exactly the bug this file exists to prevent, arrived at from the other side.
     */
    variantId: string | null;
}

export function resolvePurchaseAffordance(input: PurchaseAffordanceInput): PurchaseAffordance {
    const { type, negotiable, inStock, variantId } = input;

    if (type === 'service') {
        // No stock gate: a service's availability is its slot calendar, which this file
        // cannot see and must not guess at. `inStock` is a variant-stock concept and is
        // meaningless here — reading it would disable bookable classes at random.
        return { verb: 'book', labelKey: 'bookButton', enabled: true };
    }

    // Everything below needs a cart line, so it needs a variant and it needs stock.
    const sellable = variantId !== null && inStock;

    if (negotiable) {
        return { verb: 'bargain', labelKey: 'bargainButton', enabled: sellable };
    }

    return type === 'digital'
        ? { verb: 'buy', labelKey: 'buyNowButton', enabled: sellable }
        : { verb: 'add', labelKey: 'addToCartButton', enabled: sellable };
}

/**
 * ⚠ Exported for `test:inapp-*` and `test:bot-surface`, which assert the ladder against the
 * cart's real refusals rather than against this file's own docstring. A test that reads the
 * comment cannot catch the comment being wrong.
 */
export const __PURCHASE_LADDER_ORDER: readonly PurchaseVerb[] = Object.freeze([
    'bargain',
    'add',
    'buy',
    'book',
]);
