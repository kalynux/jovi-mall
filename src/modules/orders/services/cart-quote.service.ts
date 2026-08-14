/**
 * What a cart will cost, quoted before checkout.
 *
 * Before this the cart page had nothing honest to render. `order.service.ts` computed
 * `const tax = 0; const discount = 0; const total = base + tax - discount;`, so
 * `total_amount === base` and there was no endpoint to ask. The storefront had invented a
 * flat `DELIVERY_FEE = 1000` and a 2% "service fee" and then deleted both, because showing
 * a total nobody will be charged is worse than showing the item subtotal alone.
 *
 * ── The delivery fee is real, and the customer does not pay it ──────────────
 *
 * This is the part worth reading before changing anything here. The agency's delivery fee
 * exists and is charged — but it comes out of the **vendor's** share, not the customer's
 * total: `splitOrder` computes `vendorNet = gross − commission − deliveryTotal` where
 * `gross` is the items subtotal. So the honest quote is
 *
 *     total = subtotal        (what the customer pays)
 *     delivery = 0            (what the customer is charged for delivery)
 *     absorbedByVendor = N    (what the vendor pays the agency, for information)
 *
 * `absorbedByVendor` is reported so the UI can say "delivery included" and mean it, rather
 * than leaving a shopper to wonder whether a fee appears later. Moving that number into
 * `total` is a **business-model change**, not a display change: it would have to be paired
 * with `splitOrder` no longer deducting it, or the fee is collected twice.
 *
 * ── Why the quote cannot drift from the charge ──────────────────────────────
 *
 * The fee arithmetic is `deliveryFeeForPickupMix` in `EarningsQuoteService` — the same pure
 * function `computeShipmentDeliveryFee` calls at split time. This service does the
 * cart-shaped half (resolve each line's agency, classify its pickup source, group into the
 * shipments checkout *would* create) and then defers. That mirrors the rule the earnings
 * module already states about itself: one definition of the arithmetic, so an estimate and
 * an actual cannot disagree.
 *
 * ⚠️ It is an ESTIMATE, and two things can move it between quote and checkout: an agency
 * editing `policies.pricing`, and a vendor re-pointing a product's delivery agency. The
 * customer-facing total is unaffected by both (it is the subtotal), so the drift is
 * confined to the informational field.
 */
import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { resolveEffectiveAgencyId } from '../../catalog/domain/services/effective-delivery-agency';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { deliveryFeeForPickupMix, PickupMix } from '../../earnings/services/earnings-quote.service';
import { CustomerModel } from '../../customers/customer.model';

export interface CartQuoteVendorLine {
    vendorId: string;
    subtotal: number;
    /** Always 0 today — the vendor absorbs delivery. See the header. */
    delivery: number;
    /** What this vendor will be charged by the agency. Informational. */
    absorbedByVendor: number;
}

export interface CartQuote {
    currency: string;
    subtotal: number;
    /** What the customer is charged for delivery. `0` — the vendor absorbs it. */
    delivery: number;
    /**
     * The agencies' delivery fees for this cart, which the VENDORS will pay.
     *
     * Reported so the UI can say "delivery included" truthfully. `null` when it could not
     * be estimated — a digital cart, or an agency with no pricing policy — which is
     * deliberately distinct from `0` ("estimated, and it is nothing").
     */
    absorbedByVendor: number | null;
    /** Pinned to 0: there is no tax engine. Quoted rather than hardcoded at the call site. */
    tax: number;
    /** Pinned to 0: there is no coupon model. `price_breakdown.discount` awaits one. */
    discount: number;
    total: number;
    perVendor: CartQuoteVendorLine[];
}

export class CartQuoteService {
    constructor(
        private readonly cartService = new CartService(),
        private readonly productRepository = new ProductRepositoryMongo(),
        private readonly vendorRepository = new VendorRepository(),
        private readonly agencyRepository = new DeliveryAgencyRepository(),
    ) { }

    /**
     * Quote the caller's current cart.
     *
     * `deliveryAddressId` is accepted and **validated** even though no fee depends on it
     * yet: it is the one chance to tell a shopper their address is unusable *before*
     * checkout refuses it. `resolveDeliveryAddress` returns `chosen.geo ?? null`, so an
     * address typed by hand rather than picked from `GET /api/geo/search` yields nothing to
     * route to — and finding that out at the quote step is much better than at the moment
     * they press pay. Fee-by-distance is a deferred pricing component (see the
     * `out_of_region_*` TODOs), and when it lands this is where the address starts to
     * matter arithmetically too.
     */
    async quoteForCustomer(customerId: string, deliveryAddressId?: string): Promise<CartQuote> {
        const cart = await this.cartService.getCart(customerId);

        if (cart.items.length === 0) {
            throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 400, 'Cannot quote an empty cart');
        }

        const currency = cart.items[0].currency;
        const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

        if (deliveryAddressId) {
            await this.assertAddressUsable(customerId, deliveryAddressId);
        }

        const perVendor = await this.estimatePerVendor(cart);

        const absorbed = perVendor.every((v) => v.absorbedByVendor === 0) && cart.productType === 'digital'
            ? null
            : perVendor.reduce((sum, v) => sum + v.absorbedByVendor, 0);

        return {
            currency,
            subtotal,
            // The customer pays for the goods. Delivery is the vendor's cost.
            delivery: 0,
            absorbedByVendor: absorbed,
            tax: 0,
            discount: 0,
            total: subtotal,
            perVendor,
        };
    }

    /**
     * Reject an address the checkout would reject, at the moment the shopper can still fix it.
     *
     * Raises the same `ORDER_DELIVERY_ADDRESS_REQUIRED` (422) checkout does, so a client can
     * handle one code in both places.
     */
    private async assertAddressUsable(customerId: string, addressId: string): Promise<void> {
        const customer = await CustomerModel.findById(customerId).select('saved_addresses').lean().exec();
        const chosen = (customer?.saved_addresses ?? []).find((a) => a._id.toString() === addressId);

        if (!chosen) {
            throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404, undefined, { addressId });
        }
        if (!chosen.geo) {
            throw createAppError(
                ERROR_CODES.ORDER_DELIVERY_ADDRESS_REQUIRED,
                422,
                'That address has no geocoded location. Please re-select it from the address search so we can route your delivery.',
                { reason: 'selected_address_not_geocoded', addressId },
            );
        }
    }

    /**
     * Group the cart the way checkout will, and price each group.
     *
     * Checkout splits a cart into one order per vendor, then one shipment per **agency**
     * within that order — and the fee is per shipment. So the estimate has to reproduce both
     * levels of grouping, or a vendor whose items are split across two agencies would be
     * quoted one fee where they will be charged two.
     */
    private async estimatePerVendor(cart: { items: Array<{ vendorId: string; productId: string; price: number; quantity: number; productType: string }> }): Promise<CartQuoteVendorLine[]> {
        const byVendor = new Map<string, typeof cart.items>();
        for (const item of cart.items) {
            const group = byVendor.get(item.vendorId) ?? [];
            group.push(item);
            byVendor.set(item.vendorId, group);
        }

        const lines: CartQuoteVendorLine[] = [];

        for (const [vendorId, items] of byVendor) {
            const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

            // Digital lines never ship, so they carry no delivery cost at all.
            if (items.every((i) => i.productType !== 'physical')) {
                lines.push({ vendorId, subtotal, delivery: 0, absorbedByVendor: 0 });
                continue;
            }

            const vendor = await this.vendorRepository.findById(vendorId);
            const vendorDefaultAgencyId = vendor?.default_delivery_agency_id?.toString() ?? null;

            // agencyId → the fulfilment mix of the shipment it will receive.
            const mixByAgency = new Map<string, PickupMix>();

            for (const item of items) {
                const product = await this.productRepository.findByIdUnscoped(item.productId);
                if (!product || product.type !== 'physical') continue;

                const agencyId = resolveEffectiveAgencyId(product, vendorDefaultAgencyId);
                // No resolvable agency is not an error here — checkout raises
                // ORDER_NO_DELIVERY_AGENCY for it. A quote that threw would block the cart
                // page over a misconfiguration the shopper cannot act on.
                if (!agencyId) continue;

                const mix = mixByAgency.get(agencyId) ?? { hasPickupBased: false, hasStorageBased: false };
                const source = product.delivery?.pickupLocation?.source;
                if (source === 'vendor_address') mix.hasPickupBased = true;
                if (source === 'agency_storage') mix.hasStorageBased = true;
                mixByAgency.set(agencyId, mix);
            }

            let absorbedByVendor = 0;
            for (const [agencyId, mix] of mixByAgency) {
                if (!Types.ObjectId.isValid(agencyId)) continue;
                const agency = await this.agencyRepository.findById(agencyId);
                // No policies means no quotable price. `computeShipmentDeliveryFee` falls
                // back to a constant and logs loudly at split time; an estimate must not
                // invent a number, so this contributes nothing.
                if (!agency?.policies) continue;
                absorbedByVendor += deliveryFeeForPickupMix(agency.policies, mix);
            }

            lines.push({ vendorId, subtotal, delivery: 0, absorbedByVendor });
        }

        return lines;
    }
}

export const cartQuoteService = new CartQuoteService();
