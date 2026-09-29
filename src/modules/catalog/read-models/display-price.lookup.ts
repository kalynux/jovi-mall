import { Types } from 'mongoose';
import { ProductVariantModel } from '../models/product-variant.model';
import { ProductModel } from '../models/product.model';
import { DisplayPriceVariant, publicDisplayPrice } from './public-display-price';
import { isBargainEffective } from '../domain/services/bargain-price.rule';

/**
 * The price the storefront DISPLAYS for each variant right now, keyed by variant id.
 *
 * For checkout's `list_price_snapshot` (2026-09-27) — the "listed at" figure an account
 * statement prints beside the price paid. It lives HERE, in catalog, rather than in the order
 * build because `test:bargain-price` forbids `modules/orders` from reading the bargain window:
 * the floor an order is split against must be the checkout snapshot, never a live read. This
 * answers only "what did the shopper see", by the one storefront rule (`publicDisplayPrice`),
 * and never returns the floor.
 *
 * A variant that cannot be read yields no entry; the caller stores `null` rather than failing a
 * checkout over a record-keeping field.
 */
export async function displayPricesForVariants(
    lines: { variantId: string; productId: string }[],
): Promise<Map<string, number>> {
    const { variants, enabledOf } = await loadPricingFacts(lines);
    const prices = new Map<string, number>();
    for (const v of variants) {
        prices.set(v._id.toString(), publicDisplayPrice(enabledOf(v), v));
    }
    return prices;
}

/**
 * The vendor's FLOOR — their minimum price — for each variant that is bargainable right now,
 * keyed by variant id. A variant that is not bargainable has no entry.
 *
 * For checkout's `floor_price_snapshot` on a line that carries NO negotiation lock (owner
 * decision 2026-09-28): the bargain fee is 30% of whatever a bargainable line sold for above
 * the vendor's minimum, **whether or not the customer haggled**. A storefront sale at the ask
 * pays it on the whole window; a sale at the minimum pays nothing. A negotiated line keeps the
 * floor its lock verdict recorded and never reads this.
 *
 * Same placement argument as `displayPricesForVariants`: `test:bargain-price` forbids
 * `modules/orders` from reading the window, so catalog answers and checkout SNAPSHOTS the
 * number. The earnings split reads the snapshot, never this.
 *
 * The floor is `variant.price` — the number the lock verdict records as its floor
 * (`live-window.reader.ts`), equal to `bargain.minPrice` by `bargain-price.rule`'s invariant.
 * "Bargainable" is `isBargainEffective`: a window on a product outside the AI index is inert
 * and shelved at its floor, so it produces no uplift anyway.
 *
 * ⚠ Server-side only. The floor is the one number a shopper must never see
 * (`public-display-price.ts`); nothing returned from here may reach a response body.
 */
export async function bargainFloorsForVariants(
    lines: { variantId: string; productId: string }[],
): Promise<Map<string, number>> {
    const { variants, enabledOf } = await loadPricingFacts(lines);
    const floors = new Map<string, number>();
    for (const v of variants) {
        if (isBargainEffective(enabledOf(v), v.bargain)) floors.set(v._id.toString(), v.price);
    }
    return floors;
}

async function loadPricingFacts(lines: { variantId: string; productId: string }[]) {
    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const [variants, products] = await Promise.all([
        ProductVariantModel.find({ _id: { $in: variantIds } })
            .select('price compareAtPrice bargain')
            .lean<(DisplayPriceVariant & { _id: Types.ObjectId })[]>(),
        ProductModel.find({ _id: { $in: productIds } })
            .select('vectorisationEnabled')
            .lean<{ _id: Types.ObjectId; vectorisationEnabled?: boolean }[]>(),
    ]);
    const enabledByProduct = new Map(products.map((p) => [p._id.toString(), p.vectorisationEnabled ?? false]));
    const productOfVariant = new Map(lines.map((l) => [l.variantId, l.productId]));
    const enabledOf = (v: { _id: Types.ObjectId }): boolean =>
        enabledByProduct.get(productOfVariant.get(v._id.toString()) ?? '') ?? false;
    return { variants, enabledOf };
}
