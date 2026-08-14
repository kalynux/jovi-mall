import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { ProductType } from '../../models/product.model';

/**
 * Bargainable pricing — the one place every write path decides what a variant's
 * `bargain` window becomes.
 *
 * The window is `{ minPrice, maxPrice }`, and the invariant that makes it not a
 * second price field is **`minPrice === price`, always**. `minPrice` is the
 * variant's actual selling price; `maxPrice` is the ceiling haggling may reach.
 * Neither has anything to do with `compareAtPrice`, which sits *above* the
 * selling price as a "was" price for an unrelated reason.
 *
 * Because the invariant spans two fields that can be written independently, it
 * cannot live in Zod:
 *
 *   - `{ minPrice: 900, maxPrice: 500 }`        — one object, a schema could see it
 *   - `price: 900` + `{ maxPrice: 500 }`        — two sibling keys, it cannot
 *   - `price: 900` against a stored `{100,500}` — needs the database, it cannot
 *
 * Splitting the check would raise one error code at both 400 and 422, and
 * `npm run test:errors` censuses every createAppError site and fails when a code
 * yields two categories. So Zod checks shape and non-negativity only, and every
 * relational rule lands here at 422 (`ERROR_CODES.CATALOG_VARIANT_BARGAIN_*`).
 *
 * Called by:
 *   - `vendor-variant.controller.ts`      — createVariant / updateVariant
 *   - `SimpleProductCreateService.ts`     — the flat simple-mode create
 *   - `SimpleProductUpdateService.ts`     — the flat simple-mode patch
 *
 * Every one of them calls it BEFORE any side effect (`fileReferenceService.reconcile`,
 * `stockChangeGate.intercept`, `runInTransaction`). A 422 thrown after the stock
 * gate would leave an approval request in an agency's queue for a PATCH that
 * failed; `scripts/test/test-bargain-price.ts` asserts that ordering by source scan
 * rather than trusting it.
 *
 * Pure and dependency-free (bar the error factory), so it is testable without Mongo.
 */

/** The stored window. `minPrice` is the variant's price by construction. */
export interface BargainRange {
    minPrice: number;
    maxPrice: number;
}

/**
 * What a request proposes. `maxPrice` is required — it is the only number the
 * vendor genuinely has to choose. `minPrice` is optional and defaults to the
 * effective price, so `{ maxPrice: 45000 }` is a complete configuration.
 */
export interface BargainInput {
    minPrice?: number;
    maxPrice: number;
}

/**
 * Discriminated so the create path structurally cannot forget `price` and the
 * update path cannot forget the stored state.
 */
export type BargainWriteCommand =
    | {
        mode: 'create';
        productType: ProductType;
        /** The price this create is setting. Required on both create schemas. */
        price: number;
        bargain?: BargainInput;
        /** `name || sku` — what `details.variant` reports on every error. */
        variantLabel: string;
    }
    | {
        mode: 'update';
        productType: ProductType;
        /** The variant as STORED, before this write. */
        current: { price: number; bargain?: BargainRange | null };
        /** `undefined` = this request sets no price. */
        price?: number;
        /** `undefined` = untouched. `null` = clear. */
        bargain?: BargainInput | null;
        variantLabel: string;
    };

/**
 * What `bargain` should become. Three-valued:
 *
 *   `undefined` — leave the field out of this write entirely
 *   `null`      — clear it (VariantRepositoryMongo turns this into `$unset`)
 *   object      — a COMPLETE `{ minPrice, maxPrice }` pair
 *
 * It never returns a partial pair. That is what lets the repository keep a
 * whole-object `$set` for this field instead of the dotted-path expansion
 * `digitalConfig` needs — a half-object `$set` would silently drop `minPrice`.
 *
 * Throws (never returns) on every violation.
 */
export function resolveBargainWrite(cmd: BargainWriteCommand): BargainRange | null | undefined {
    // A clear is always allowed, on every product type. Refusing it on a service
    // product would strand a range on a legacy or mis-written variant with no API
    // left to remove it.
    if (cmd.mode === 'update' && cmd.bargain === null) return null;

    // Setting a range is refused on service products. 400, not 422, for parity
    // with the twelve sibling "this field does not apply to this product type"
    // refusals in vendor-variant.controller.ts, all CATALOG_PRODUCT_INVALID_TYPE
    // at 400. A dedicated code gives the frontend something specific to key on.
    if (cmd.productType === 'service') {
        if (cmd.bargain) {
            throw createAppError(
                ERROR_CODES.CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED,
                400,
                undefined,
                { variant: cmd.variantLabel, productType: cmd.productType },
            );
        }
        // A bare price edit on a service variant must never *create* a range, even
        // if one somehow exists — that would be the ban bypassed by a side door.
        return undefined;
    }

    if (cmd.mode === 'create') {
        if (!cmd.bargain) return undefined;
        return build(cmd.bargain, cmd.price, cmd.variantLabel);
    }

    const stored = cmd.current.bargain ?? undefined;

    if (cmd.bargain) {
        // The effective price is this request's, if it sets one — a body changing
        // both must be judged against the price it is about to write, not the old one.
        return build(cmd.bargain, cmd.price ?? cmd.current.price, cmd.variantLabel);
    }

    // No `bargain` key in the body. Only a price change matters, and only if a
    // range is already configured.
    if (cmd.price === undefined || !stored) return undefined;

    // Auto-sync: `minPrice` follows the price, so the invariant cannot break by
    // editing the price alone. Raising a price past the ceiling is refused rather
    // than silently lifting the ceiling — that is the vendor's call, made by
    // sending `price` and `bargain.maxPrice` together.
    return assertOrdered(
        { minPrice: cmd.price, maxPrice: stored.maxPrice },
        cmd.price,
        cmd.variantLabel,
    );
}

/**
 * Whether a stored range is EFFECTIVE right now — the read model's `bargainable`.
 *
 * Bargaining is gated on the parent product being in the AI index, since that is
 * what the negotiating agent reads its catalogue from. A range on an opted-out
 * product is kept and reported inert, never deleted: `VectorisationService`
 * silently flips the flag off whenever a product becomes ineligible, so deleting
 * on the flip would destroy vendor configuration nobody asked to remove.
 *
 * `=== true` rather than truthy: products predating the vectorisation columns have
 * no such key and `ProductMapper.toDomain` does not coerce it. `!= null` catches
 * both `undefined` (never configured) and `null` (a write-time clear signal that
 * `toDomain` never produces).
 */
export function isBargainEffective(
    vectorisationEnabled: boolean,
    bargain: BargainRange | null | undefined,
): boolean {
    return vectorisationEnabled === true && bargain != null;
}

/**
 * Resolve a proposed window against the price it must agree with.
 * `minPrice` omitted means "use the price" — the ergonomic that lets a vendor
 * configure bargaining by naming only a ceiling.
 */
function build(input: BargainInput, price: number, variantLabel: string): BargainRange {
    if (input.minPrice !== undefined && input.minPrice !== price) {
        throw createAppError(
            ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH,
            422,
            undefined,
            { variant: variantLabel, price, minPrice: input.minPrice },
        );
    }

    return assertOrdered({ minPrice: price, maxPrice: input.maxPrice }, price, variantLabel);
}

/**
 * `maxPrice >= minPrice`. Equality is allowed — a degenerate window is a vendor
 * saying "bargainable, no headroom yet", which is a coherent thing to configure.
 */
function assertOrdered(range: BargainRange, price: number, variantLabel: string): BargainRange {
    if (range.maxPrice < range.minPrice) {
        throw createAppError(
            ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID,
            422,
            undefined,
            { variant: variantLabel, price, minPrice: range.minPrice, maxPrice: range.maxPrice },
        );
    }
    return range;
}
