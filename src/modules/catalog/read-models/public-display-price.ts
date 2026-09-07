/**
 * What price the STOREFRONT quotes for a variant — the one rule, in both dialects.
 *
 * A bargainable variant is shelved at its **ask** (`bargain.maxPrice`) rather than at
 * `variant.price`, which becomes the vendor's floor (BARGAINING-AGENT-PLAN D-1). A
 * non-bargainable variant is unchanged.
 *
 * ── WHY THE MONGO HALF LIVES BESIDE THE TYPESCRIPT HALF ─────────────────────
 *
 * The storefront derives **five** things from a variant's price, and they are computed in
 * two different places: `price`, `priceMin`, `priceMax`, the `price_asc`/`price_desc` sort
 * and the `minPrice`/`maxPrice` filter band come out of an **aggregation pipeline**
 * (`public-catalog.repository.mongo.ts`), while the product detail's per-variant `price`
 * comes out of a **pure mapper** (`dto/public-product.dto.ts`). If display flips and any one
 * of them does not, a shopper filtering "under 40 000" is shown a product displaying 45 000
 * — the failure this file exists to make impossible.
 *
 * So the predicate is written **once, in two dialects, adjacent**, rather than as a TS rule
 * plus a `$cond` somebody hand-rolls in a pipeline three files away. `test:public-catalog`
 * § 2b asserts the two agree on the same fixtures.
 *
 * ── THE FLOOR IS NEVER PUBLISHED ────────────────────────────────────────────
 *
 * ⚠ **`bargain.minPrice` must never reach a public route.** It is the number the vendor will
 * not go below, and handing it to a shopper hands it to the person on the other side of the
 * negotiation. Nothing here emits it — the ask is the only half of the window that is
 * buyer-facing — and `test:public-catalog` § 4 asserts its absence from every public DTO.
 *
 * ── compareAtPrice ──────────────────────────────────────────────────────────
 *
 * `compareAtPrice` is a "was" price that sits *above* the selling price, and it is unrelated
 * to the bargain window — so a vendor can perfectly legitimately hold `price 24 000 ·
 * compareAtPrice 30 000 · maxPrice 45 000`. Publishing that pair after the flip renders a
 * strikethrough 30 000 above a live 45 000: "was cheaper, now dearer". A **bargainable**
 * variant therefore publishes `compareAtPrice` only while it is strictly above the ask.
 *
 * The narrowing is deliberately scoped to bargainable variants: `PriceResolverService`
 * already applies exactly this rule when it decides whether a line carries a `discount`, but
 * applying it here to *every* variant would change what the storefront publishes for
 * products this feature does not touch. See § 8 of BARGAINING-AGENT-PLAN.md.
 */
import { BargainRange, isBargainEffective } from '../domain/services/bargain-price.rule';

/** The two variant fields the rule reads, plus the window. */
export interface DisplayPriceVariant {
    price: number;
    compareAtPrice?: number | null;
    bargain?: BargainRange | null;
}

/**
 * The price a shopper is quoted.
 *
 * `vectorisationEnabled` comes from the variant's PRODUCT — a window on an opted-out product
 * is kept and inert (`isBargainEffective`), so such a variant is still shelved at its floor.
 */
export function publicDisplayPrice(
    vectorisationEnabled: boolean,
    variant: DisplayPriceVariant,
): number {
    const bargain = variant.bargain;
    return bargain != null && isBargainEffective(vectorisationEnabled, bargain)
        ? bargain.maxPrice
        : variant.price;
}

/**
 * The "was" price a shopper is shown, or `null` when there is none to show.
 *
 * Null rather than omitted: absent is a state the storefront renders, which is the
 * convention the whole public DTO follows for this field.
 */
export function publicCompareAtPrice(
    vectorisationEnabled: boolean,
    variant: DisplayPriceVariant,
): number | null {
    const compareAt = variant.compareAtPrice ?? null;
    const bargain = variant.bargain;
    if (!(bargain != null && isBargainEffective(vectorisationEnabled, bargain))) return compareAt;
    return compareAt !== null && compareAt > bargain.maxPrice ? compareAt : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The aggregation dialect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where each input sits in the pipeline the expression is being built for.
 *
 * Paths rather than a fixed shape because the two pipelines that need this have **different
 * roots**: the browse/list reads are rooted on a *product* and reach the variant through a
 * `$map` variable (`'$$v.price'`), while the SKU resolution is rooted on a *variant* and
 * reaches the product through a `$lookup` (`'$product.vectorisationEnabled'`). One expression
 * builder serves both; a second copy is how one of them ends up quoting the floor.
 */
export interface DisplayPricePaths {
    /** The PRODUCT's `vectorisationEnabled` flag. */
    vectorisationEnabled: string;
    /** The VARIANT's `bargain.maxPrice`. */
    bargainMaxPrice: string;
    /** The VARIANT's `price`. */
    price: string;
    /** The VARIANT's `compareAtPrice`. Only needed by `displayCompareAtPriceExpr`. */
    compareAtPrice?: string;
}

/**
 * `isBargainEffective`, as a pipeline expression.
 *
 * ⚠ The window is tested through **`maxPrice`**, not through the `bargain` sub-document, and
 * that is on purpose: a missing field path and an explicit `null` both compare equal to
 * `null` in the aggregation language, so `$ne` covers "never configured" and "cleared"
 * together — exactly what `bargain != null` does on the TypeScript side. Testing the
 * sub-document instead would additionally have to trust that a stored window always carries a
 * `maxPrice`; testing the number needs no such assumption and degrades to the floor if one is
 * ever missing.
 */
export function bargainEffectiveExpr(paths: DisplayPricePaths): Record<string, unknown> {
    return {
        $and: [
            { $eq: [paths.vectorisationEnabled, true] },
            { $ne: [{ $ifNull: [paths.bargainMaxPrice, null] }, null] },
        ],
    };
}

/** `publicDisplayPrice`, as a pipeline expression. */
export function displayPriceExpr(paths: DisplayPricePaths): Record<string, unknown> {
    return { $cond: [bargainEffectiveExpr(paths), paths.bargainMaxPrice, paths.price] };
}

/**
 * `publicCompareAtPrice`, as a pipeline expression.
 *
 * The comparison is against `bargainMaxPrice` rather than against a recomputed display price
 * because it only runs inside the branch where the two are equal by construction. A null
 * `compareAtPrice` sorts below every number in BSON, so the `$gt` is false and the answer is
 * `null` either way — the missing case needs no branch of its own.
 */
export function displayCompareAtPriceExpr(
    paths: DisplayPricePaths & { compareAtPrice: string },
): Record<string, unknown> {
    const compareAt = { $ifNull: [paths.compareAtPrice, null] };
    return {
        $cond: [
            bargainEffectiveExpr(paths),
            { $cond: [{ $gt: [compareAt, paths.bargainMaxPrice] }, compareAt, null] },
            compareAt,
        ],
    };
}
