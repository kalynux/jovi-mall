/**
 * What the bargaining sub-agent is shown about a product — the shaping rules, pure.
 *
 * Everything here is a function of values already in hand: no Mongo, no storage, no
 * config. That is deliberate, because the two rules worth pinning in this file are both
 * rules a behavioural test could only observe through a database —
 * `test:negotiation-tools` asserts them directly instead.
 *
 * ── THE WINDOW IS CALLED `floor` / `ask` HERE, AND NOT `minPrice` / `maxPrice` ────
 *
 * The stored shape is `bargain: { minPrice, maxPrice }` and it stays that way
 * (`bargain-price.rule.ts` owns it). This surface renames both halves on the way out,
 * once, and the rename is the point rather than a preference:
 *
 *   - `minPrice` reads, to anything that has not read the rule, as *"the least the
 *     customer pays"*. It is the opposite — it is the vendor's **floor**, the number they
 *     will never go below, and `minPrice === variant.price` always. The consumer here is a
 *     language model choosing what to say to the person on the other side of that number.
 *   - `maxPrice` reads as *"the most the customer pays"*, which after D-1 is true but for
 *     the wrong reason: it is the **ask**, the shelf price a bargainable variant is now
 *     displayed at, and the number the haggle opens from.
 *
 * BARGAINING-AGENT-PLAN.md § 4 invariant 3 states the correspondence — `floor ===
 * variant.price`, `ask === bargain.maxPrice` — and this file is where it is applied.
 *
 * ── THE FLOOR IS DELIBERATELY DISCLOSED HERE, AND NOWHERE ELSE ───────────────────
 *
 * ⚠ Two places strip the window before it can reach a customer-facing model:
 * `product_search()` in `product_vectors.sql` does `metadata - 'bargain_windows'`, and
 * n8n's `Shape Result` allowlist drops it again. **Both stay in force.** D-2 lifts the
 * rule for the bargaining sub-agent *only*, through its own tool, behind the service
 * token — the same judgement `internal-vectoriser.routes.ts` already records about
 * `/payloads`: this is a door that hands the window to a SERVER, and it must never become
 * a door that hands it to a chat.
 */

import { BargainRange, isBargainEffective } from '../../catalog/domain/services/bargain-price.rule';

/**
 * The platform's single currency.
 *
 * There is no per-product or per-variant currency column: `cart.model.ts` defaults the
 * cart's to `'XAF'`, `CartService.getCart` passes the same literal, and every price in the
 * catalogue is denominated in it. Quoted here rather than hardcoded at four call sites so
 * that a second currency lands as one compile error in this file instead of four silent
 * mislabellings in a chat window.
 */
export const NEGOTIATION_TOOL_CURRENCY = 'XAF';

/** The vendor's haggling window, in the words the sub-agent's playbook uses. */
export interface NegotiationWindow {
    /** `variant.price` — the number the vendor will never go below. */
    floor: number;
    /** `bargain.maxPrice` — the shelf price, and where the haggle opens. */
    ask: number;
}

/**
 * Real stock, in the only three facts a truthful scarcity claim can be built from.
 *
 * ⚠ **`sellable` is not a count and a count is not `sellable`.** The playbook allows
 * *"I have exactly 2 left"* only when it is a fact from this tool — and `sellable` can be
 * `true` with `onHand: 0`, because a vendor may permit overselling (`allow_oversell`) or
 * hold infinite stock. So a scarcity sentence may be derived from `onHand` when it is a
 * number, and never from `sellable`.
 */
export interface NegotiationStock {
    /** Units on hand. `null` when the variant is infinite-stock — not zero. */
    onHand: number | null;
    isInfinite: boolean;
    /** Whether an order for this variant would be accepted today. */
    sellable: boolean;
}

/** The variant fields this surface reads. Structural, so both a lean doc and a domain object fit. */
export interface VariantLike {
    price: number;
    compareAtPrice?: number | null;
    bargain?: BargainRange | null;
    stock?: number | null;
    isInfiniteStock?: boolean | null;
    allow_oversell?: boolean | null;
}

/**
 * The window, or `null` when this variant is not bargainable **right now**.
 *
 * `isBargainEffective` is the shared predicate and is imported rather than re-expressed:
 * a window on a product whose `vectorisationEnabled` is false is *configured and inert*
 * (kept, never deleted — see `bargain-price.rule.ts`), and a second opinion about that
 * here would hand the sub-agent a window on a product the index does not carry.
 */
export function windowOf(
    vectorisationEnabled: boolean,
    variant: Pick<VariantLike, 'price' | 'bargain'>,
): NegotiationWindow | null {
    const bargain = variant.bargain;
    if (!isBargainEffective(vectorisationEnabled, bargain) || bargain == null) return null;
    return { floor: variant.price, ask: bargain.maxPrice };
}

/**
 * What a customer would pay for this variant with no haggling at all.
 *
 * The ask for a bargainable variant (D-1: it is shelved at its ask), the price otherwise.
 * This is the number the storefront displays, restated here because the sub-agent has to
 * know what the customer has already been shown before it opens.
 */
export function askingPriceOf(
    vectorisationEnabled: boolean,
    variant: Pick<VariantLike, 'price' | 'bargain'>,
): number {
    return windowOf(vectorisationEnabled, variant)?.ask ?? variant.price;
}

/**
 * The lowest price this variant could ever be sold at.
 *
 * The floor for a bargainable variant, the price otherwise — and since `minPrice ===
 * price` always, both branches are `variant.price`. Written as one function anyway,
 * because the *reason* differs and a future second price field would split them.
 */
export function reachablePriceOf(variant: Pick<VariantLike, 'price'>): number {
    return variant.price;
}

/**
 * ⚠ **THE PRICE BOUND — this is the rule the whole substitute search turns on.**
 *
 * A budget bounds the **floor**, never the ask. The question a bargaining agent is asking
 * when it says "under 40 000" is *"is there anything I could get this customer into for
 * 40 000"*, and the lowest number a negotiation can reach is the floor. Bounding on the
 * ask would hide exactly the products the agent exists to negotiate down — a variant
 * shelved at 45 000 with a floor of 38 000 is squarely within a 40 000 budget and would
 * have been filtered out.
 *
 * It is also what `product_search()` already does: its `p_price_max` compares against
 * `price_min`, the minimum `variant.price` across the product, which is the minimum floor.
 * Mirroring it keeps the Postgres index and this tool answering the same question.
 *
 * An absent budget admits everything, so the caller need not special-case it.
 */
export function withinBudget(variant: Pick<VariantLike, 'price'>, budget: number | undefined): boolean {
    if (budget === undefined) return true;
    return reachablePriceOf(variant) <= budget;
}

/**
 * Stock, derived exactly as the storefront's `_inStock` derives it.
 *
 * The three-way `isInfiniteStock || allow_oversell || stock > 0` is copied from
 * `PublicCatalogRepositoryMongo.variantJoinStages`, which is the definition a shopper is
 * already being shown. A tool that disagreed with the grid would have the sub-agent
 * refusing a sale the cart would have accepted.
 */
export function stockOf(variant: VariantLike): NegotiationStock {
    const isInfinite = variant.isInfiniteStock === true;
    const onHand = isInfinite ? null : (variant.stock ?? 0);
    return {
        onHand,
        isInfinite,
        sellable: isInfinite || variant.allow_oversell === true || (variant.stock ?? 0) > 0,
    };
}

/**
 * The "was" price, or `null`.
 *
 * ⚠ Narrowed for a bargainable variant, and the reason is the same one
 * `read-models/public-display-price.ts` gives about the storefront: `compareAtPrice` sits
 * *above* the selling price for an unrelated reason, so a vendor may legitimately hold
 * `price 24 000 · compareAtPrice 30 000 · ask 45 000`. Handing that pair to the sub-agent
 * invites it to say "normally 30 000, today 45 000" — a sentence that is worse than saying
 * nothing. Published only while it is strictly above the number the customer is quoted.
 */
export function compareAtPriceOf(
    vectorisationEnabled: boolean,
    variant: Pick<VariantLike, 'price' | 'compareAtPrice' | 'bargain'>,
): number | null {
    const compareAt = variant.compareAtPrice ?? null;
    if (compareAt === null) return null;
    return compareAt > askingPriceOf(vectorisationEnabled, variant) ? compareAt : null;
}
