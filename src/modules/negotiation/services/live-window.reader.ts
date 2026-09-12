import { ClientSession } from 'mongoose';

import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { isBargainEffective } from '../../catalog/domain/services/bargain-price.rule';
import { NEGOTIATION_CONFIG } from '../config/negotiation.config';

/**
 * "The vendor's window, as it stands right now" — read in ONE place, for the two
 * readers that need it.
 *
 * ── Why this is shared rather than copied ───────────────────────────────────
 *
 * Two things in this module ask the question, at the two ends of a negotiation:
 *
 *   `NegotiationService.readLiveWindow` — every turn, so the gate judges a
 *       proposed price against the live window and never the session snapshot
 *       (invariant 3).
 *   `NegotiatedPriceResolver`           — at peek and at consume, so a lock is
 *       re-validated against the window in force at the moment of sale (D-10).
 *
 * They must agree about what "the window" is, down to the `isBargainEffective`
 * gate: a variant the dashboard reports as non-negotiable cannot be negotiated,
 * and must not be honoured at a negotiated price either. Two derivations of one
 * window is exactly the drift the port between `catalog` and `negotiation`
 * exists to prevent one level up — the argument does not stop at the module
 * boundary.
 *
 * ── It reports a MISS; it does not decide what a miss means ─────────────────
 *
 * The two callers owe their callers different answers for the same absence. The
 * gate raises the catalogue's own codes at 404/422, because its caller is a tool
 * being told it named something unusable. The resolver returns `window_moved`,
 * because its caller is a checkout holding a price promise. So this returns a
 * discriminated result and neither throws nor maps — the mapping is each
 * caller's, and both are one short switch.
 */

/** The live window plus the identifiers a caller needs alongside it. */
export interface LiveWindow {
    /**
     * ⚠ `variant.price`, never `bargain.minPrice`. The two are held identical by
     * `resolveBargainWrite`, and reading the price is what keeps this correct if
     * that invariant is ever relaxed.
     */
    floor: number;
    ask: number;
    productId: string;
    vendorId: string;
    currency: string;
}

/**
 * Why there is no window. Ordered as the read encounters them, and deliberately
 * finer-grained than either caller needs: the gate maps four of the five onto
 * distinct catalogue codes, and collapsing them here would flatten a 404 into a
 * 422 for a caller that can act on the difference.
 */
export type LiveWindowMiss =
    | 'variant_not_found'
    | 'variant_archived'
    | 'product_not_found'
    | 'product_inactive'
    | 'not_bargainable';

export type LiveWindowRead =
    | { ok: true; window: LiveWindow }
    | { ok: false; miss: LiveWindowMiss; productStatus?: string };

export class LiveWindowReader {
    constructor(
        private readonly products = new ProductRepositoryMongo(),
        private readonly variants = new VariantRepositoryMongo(),
    ) {}

    /**
     * The variant's window as it stands now.
     *
     * `options.session` exists for the consume path only: that read happens
     * inside the order's transaction, so it must see the same snapshot as the
     * burn it is about to authorise. Reading it outside would let a vendor's
     * price edit land between the check and the write, which is the whole class
     * of bug a transaction is being used to avoid.
     */
    async read(
        variantId: string,
        options?: { session?: ClientSession },
    ): Promise<LiveWindowRead> {
        const variant = await this.variants.findById(variantId, options);
        if (!variant) return { ok: false, miss: 'variant_not_found' };
        if (variant.status !== 'active') return { ok: false, miss: 'variant_archived' };

        const product = await this.products.findByIdUnscoped(variant.productId, options);
        if (!product) return { ok: false, miss: 'product_not_found' };
        if (product.status !== 'active') {
            return { ok: false, miss: 'product_inactive', productStatus: product.status };
        }

        if (!isBargainEffective(product.vectorisationEnabled, variant.bargain)) {
            return { ok: false, miss: 'not_bargainable' };
        }

        // Non-null by `isBargainEffective`, which is the point of routing through
        // it rather than testing `variant.bargain` here and having two opinions.
        const bargain = variant.bargain!;

        return {
            ok: true,
            window: {
                floor: variant.price,
                ask: bargain.maxPrice,
                productId: variant.productId,
                vendorId: product.vendorId,
                currency: NEGOTIATION_CONFIG.DEFAULT_CURRENCY,
            },
        };
    }
}

export const liveWindowReader = new LiveWindowReader();
