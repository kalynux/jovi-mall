import { Types } from 'mongoose';
import { ProductVariantModel } from '../models/product-variant.model';
import { ProductModel } from '../models/product.model';
import { DisplayPriceVariant, publicDisplayPrice } from './public-display-price';

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

    const prices = new Map<string, number>();
    for (const v of variants) {
        const productId = productOfVariant.get(v._id.toString()) ?? '';
        prices.set(v._id.toString(), publicDisplayPrice(enabledByProduct.get(productId) ?? false, v));
    }
    return prices;
}
