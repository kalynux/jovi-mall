import { Types } from 'mongoose';
import { ProductVariantModel } from '../models/product-variant.model';
import { ShippingConfigModel } from '../models/shipping-config.model';
import { resolveItemWeightGrams, ResolvedItemWeight } from '../../earnings/domain/delivery-pricing';

/**
 * The per-unit weight of each line, for the delivery-fee formula (ADR-A11 D-4), keyed by
 * variant id. Variant weight first, then the product's shipping config, then the
 * `DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS` item-count fallback — `resolveItemWeightGrams` decides,
 * this only reads (two batched queries, never per line).
 *
 * Every requested variant gets an entry: an unreadable one resolves to the fallback rather
 * than failing a quote or a checkout over a pricing input. Checkout SNAPSHOTS the result onto
 * the order item (`weight_grams` + `weight_source`); the split reads the snapshot, never this.
 */
export async function itemWeightsForVariants(
    lines: { variantId: string; productId: string }[],
): Promise<Map<string, ResolvedItemWeight>> {
    const variantIds = [...new Set(lines.map((l) => l.variantId))].filter((id) => Types.ObjectId.isValid(id));
    const productIds = [...new Set(lines.map((l) => l.productId))].filter((id) => Types.ObjectId.isValid(id));

    const [variants, configs] = await Promise.all([
        variantIds.length
            ? ProductVariantModel.find({ _id: { $in: variantIds } })
                  .select('weight')
                  .lean<{ _id: Types.ObjectId; weight?: number | null }[]>()
            : Promise.resolve([]),
        productIds.length
            ? ShippingConfigModel.find({ productId: { $in: productIds }, deletedAt: null })
                  .select('productId weight')
                  .lean<{ productId: Types.ObjectId; weight?: number | null }[]>()
            : Promise.resolve([]),
    ]);

    const variantWeight = new Map(variants.map((v) => [v._id.toString(), v.weight ?? null]));
    const configWeight = new Map(configs.map((c) => [c.productId.toString(), c.weight ?? null]));

    const out = new Map<string, ResolvedItemWeight>();
    for (const line of lines) {
        out.set(
            line.variantId,
            resolveItemWeightGrams({
                variantWeight: variantWeight.get(line.variantId) ?? null,
                shippingConfigWeight: configWeight.get(line.productId) ?? null,
            }),
        );
    }
    return out;
}
