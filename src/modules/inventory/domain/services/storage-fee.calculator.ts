import { IStorageBasedPricing } from '../../../delivery/delivery-agency.model';

/**
 * What an agency should be charging to warehouse one SKU, for one month.
 *
 * ## This is a DISPLAY figure and nothing else
 *
 * The platform does not track storage payment, does not invoice it, and does not
 * act on it. `monthly_storage_fee_per_sku` has been collected at agency onboarding
 * since day one and has never been charged — `EarningsQuoteService` deliberately
 * excludes it from the per-order split because it is rent, not a delivery fee.
 * Nothing here changes that. It exists so an agency can see, per SKU, the number it
 * is owed and go and collect it out-of-band; the only platform lever attached to it
 * is the agency's own manual suspension.
 *
 * ## Why size is shown but does not price
 *
 * The rate is flat, **per SKU per month**, because that is the only rate the
 * agency's policy actually holds. Dimensions and the computed volume are surfaced
 * alongside so an agency can sanity-check that rate against what it is really
 * shelving (and negotiate it out-of-band if a pallet is being charged like a
 * envelope) — but they are not inputs. A client must not multiply by them.
 *
 * Pure — no I/O — so the arithmetic is testable without a database.
 */

/** Where a variant's dimensions came from. */
export type StorageSizeSource = 'variant' | 'product_default' | 'unknown';

export interface StorageSize {
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
    /** `l × w × h`, only when all three are known. */
    volumeCm3: number | null;
    weightG: number | null;
    source: StorageSizeSource;
}

export interface StorageFeeQuote {
    /** The only basis there is today. Named so a later volumetric basis is additive. */
    basis: 'per_sku_monthly';
    /**
     * `policies.pricing.storage_based.enabled`. When false the agency does not offer
     * warehousing at all, the estimate is 0, and the screen should say so rather than
     * showing a rate nobody agreed to.
     */
    storageBasedEnabled: boolean;
    monthlyRatePerSku: number;
    /** The quantity the fee is computed over — see `resolveStorageQuantity`. */
    quantity: number;
    monthlyEstimate: number;
    size: StorageSize | null;
}

/** Dimensions as they may appear on a variant or a product's shipping config. */
export interface DimensionSource {
    weight?: number | null;
    length?: number | null;
    width?: number | null;
    height?: number | null;
}

/**
 * The variant's own dimensions win; the product's shipping-config defaults fill in
 * when the variant carries none. That precedence is not invented here — it is the
 * one `shipping-config.model.ts` already documents ("Variant dimensions override
 * product defaults when present").
 *
 * `source` reports which won, because "we don't know how big this is" and "it is
 * 30×20×12" must be distinguishable on a screen that is justifying a charge.
 */
export function resolveStorageSize(
    variant: DimensionSource | null | undefined,
    productDefaults: DimensionSource | null | undefined,
): StorageSize | null {
    const hasAny = (d: DimensionSource | null | undefined): boolean =>
        !!d && (d.length != null || d.width != null || d.height != null || d.weight != null);

    const chosen = hasAny(variant) ? variant! : hasAny(productDefaults) ? productDefaults! : null;
    const source: StorageSizeSource = hasAny(variant)
        ? 'variant'
        : hasAny(productDefaults)
            ? 'product_default'
            : 'unknown';

    if (!chosen) return null;

    const lengthCm = chosen.length ?? null;
    const widthCm = chosen.width ?? null;
    const heightCm = chosen.height ?? null;

    return {
        lengthCm,
        widthCm,
        heightCm,
        // Null rather than 0 when a dimension is missing: 0 would read as "no volume",
        // which is a claim, and this field's whole job is to be checkable.
        volumeCm3: lengthCm != null && widthCm != null && heightCm != null
            ? lengthCm * widthCm * heightCm
            : null,
        weightG: chosen.weight ?? null,
        source,
    };
}

/**
 * The quantity a storage fee is charged over.
 *
 * **Not `quantity_on_hand`.** That counter is Phase 2's and is 0 on every row
 * today, so pricing off it would quote every agency zero. The number used is the
 * catalogue quantity for the SKU — which is legitimate here precisely because of
 * the other two changes shipped with this: it is now a figure *both parties signed
 * off on* (nobody moves it unilaterally on a warehoused SKU), and it is guaranteed
 * finite (unlimited stock blocks activation for `agency_storage` products).
 *
 * An infinite-stock SKU still yields 0 — it can only be a legacy or suspended row,
 * and inventing a quantity for it would be a fabricated charge.
 */
export function resolveStorageQuantity(
    catalogStock: { quantity: number; isInfinite: boolean },
): number {
    if (catalogStock.isInfinite) return 0;
    return Math.max(0, catalogStock.quantity);
}

export function quoteStorageFee(
    pricing: IStorageBasedPricing | null | undefined,
    catalogStock: { quantity: number; isInfinite: boolean },
    size: StorageSize | null,
): StorageFeeQuote {
    const storageBasedEnabled = pricing?.enabled ?? false;
    const monthlyRatePerSku = pricing?.monthly_storage_fee_per_sku ?? 0;
    const quantity = resolveStorageQuantity(catalogStock);

    return {
        basis: 'per_sku_monthly',
        storageBasedEnabled,
        monthlyRatePerSku,
        quantity,
        monthlyEstimate: storageBasedEnabled ? monthlyRatePerSku * quantity : 0,
        size,
    };
}
