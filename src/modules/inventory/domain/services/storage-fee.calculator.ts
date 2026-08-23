import { IStorageBasedPricing } from '../../../delivery/delivery-agency.model';

/**
 * What an agency should be charging to warehouse one SKU, for one month.
 *
 * ## This is a figure the platform now RECORDS, and still does not charge (D-7)
 *
 * Step 14 gave it a durable home: `AgencyStorageInvoiceService` issues a monthly
 * statement per (agency, vendor) built from these quotes, which both sides can read and
 * the agency can mark settled. **No money moves.** `EarningsQuoteService` still excludes
 * `monthly_storage_fee_per_sku` from every per-order split — it is rent, not a delivery
 * fee — and the platform neither collects it from the vendor nor pays it to the agency.
 * What changed is that the number is written down instead of merely rendered.
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
    /**
     * Where that quantity came from.
     *
     * `counted` — an agency has recorded intake on this shelf and the figure is theirs.
     * `uncounted` — nobody has, so the quantity is 0 and the estimate with it. A client
     * must render those two differently: "0 due" and "not counted yet" are not the same
     * statement, and conflating them is how an agency concludes it is owed nothing.
     */
    quantityBasis: 'counted' | 'uncounted';
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
 * ⚠ **This is `quantity_on_hand` now, and it used to be the catalogue quantity.** The old
 * comment here said "not `quantity_on_hand` — that counter is Phase 2's and is 0 on every
 * row today", which was true and is the reason the catalogue number stood in for it.
 * Step 14 makes the counter real (D-6), and rent is owed on what is physically on a shelf,
 * not on what a vendor lists for sale. The two can now legitimately differ — a vendor
 * selling from two channels, a delivery not yet booked in, a variance not yet settled —
 * and billing the wrong one would put a number on an invoice that nobody can go and count.
 *
 * **An UNCOUNTED row yields 0**, and that is the visible cost of D-6: until an agency
 * records intake, the platform does not know what it is holding and will not invent a
 * charge for it. The quote reports which case it is in (`quantityBasis`) so a screen can
 * say "no intake recorded" rather than "nothing owed".
 *
 * A NEGATIVE balance also yields 0. It means more went out than was ever recorded in, so
 * the shelf holds nothing this can honestly bill for, and the agency owes itself a count.
 */
export function resolveStorageQuantity(
    warehoused: { onHand: number; isCounted: boolean },
): number {
    if (!warehoused.isCounted) return 0;
    return Math.max(0, warehoused.onHand);
}

export function quoteStorageFee(
    pricing: IStorageBasedPricing | null | undefined,
    warehoused: { onHand: number; isCounted: boolean },
    size: StorageSize | null,
): StorageFeeQuote {
    const storageBasedEnabled = pricing?.enabled ?? false;
    const monthlyRatePerSku = pricing?.monthly_storage_fee_per_sku ?? 0;
    const quantity = resolveStorageQuantity(warehoused);

    return {
        basis: 'per_sku_monthly',
        storageBasedEnabled,
        monthlyRatePerSku,
        quantity,
        quantityBasis: warehoused.isCounted ? 'counted' : 'uncounted',
        monthlyEstimate: storageBasedEnabled ? monthlyRatePerSku * quantity : 0,
        size,
    };
}
