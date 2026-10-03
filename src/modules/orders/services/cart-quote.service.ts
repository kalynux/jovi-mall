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
 *
 * ── The delivery-cost cap is quoted too (ADR-A07) ───────────────────────────
 *
 * Because the vendor absorbs the fee, checkout refuses a shop's part of the basket that is too
 * small to carry it (`ORDER_BELOW_DELIVERY_MINIMUM`). Each `perVendor` line reports that verdict
 * as `deliveryMinimum`, computed by `DeliveryCostCapService` — the service checkout itself calls
 * — so a client can say "add 1 200 FCFA from this shop" before the pay button, not after it.
 *
 * ⚠ It depends on the payment method (COD adds the agency's handling fee and is checked per
 * shipment), so the quote takes an optional `paymentMethod`, default `online`. It counts the
 * bargain fee from the vendor's CURRENT minimum on every bargainable line (the fee is owed haggled
 * or not, 2026-09-28); checkout uses the snapshotted floor — a negotiated line's lock verdict — so
 * the two can differ only if the vendor moves their minimum in between. Checkout's verdict is exact.
 *
 * ── Whether cash on delivery is possible is quoted too (ADR-A09 G-10, 2026-10-03) ──
 *
 * `cashOnDelivery` answers "would checkout refuse this basket as COD?" BEFORE the pay screen, on
 * every quote whatever `paymentMethod` was asked. The rule is checkout's own:
 * `codEligibilityService.assertVendorOrderEligible` — vendor COD terms first, then each carrying
 * agency (COD-capable + verified, order within its per-order maximum) — fed the agencies the cart
 * groups each shop's shipments by. The Mini App's `cashOnDeliveryRefusal` reads the SAME
 * refusal (`quoteWithCodRefusal`), so the web shop and the bot cannot disagree. The verdict
 * carries a reason and the refusing shops' ids only; no vendor setting or agency limit leaves.
 * ⚠ The COD exposure limits (agency / vendor holds) are deliberately NOT here: a hold never
 * refuses the customer — the order is placed and held for the vendor.
 */
import { Types } from 'mongoose';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { resolveEffectiveAgencyId } from '../../catalog/domain/services/effective-delivery-agency';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { deliveryFeeForPickupMix } from '../../earnings/services/earnings-quote.service';
import { bargainFloorsForVariants } from '../../catalog/read-models/display-price.lookup';
import { CustomerModel } from '../../customers/customer.model';
import { OrderPaymentMethod } from '../order.model';
import { CodEligibilityService, codEligibilityService } from '../../cod/services/cod-eligibility.service';
import {
    belowMinimumError,
    DeliveryCapAgencyGroup,
    DeliveryCapLine,
    DeliveryCapUnitVerdict,
    DeliveryCostCapService,
    deliveryCostCapService,
} from './delivery-cost-cap.service';

export interface CartQuoteVendorLine {
    vendorId: string;
    subtotal: number;
    /** Always 0 today — the vendor absorbs delivery. See the header. */
    delivery: number;
    /** What this vendor will be charged by the agency. Informational. */
    absorbedByVendor: number;
    /**
     * Whether this shop's part of the basket can carry its delivery cost (ADR-A07). When `met` is
     * false, checkout refuses with `ORDER_BELOW_DELIVERY_MINIMUM`. `null` means NOT EVALUATED — a
     * digital-only shop (no delivery), or a vendor whose plan could not be resolved.
     */
    deliveryMinimum: DeliveryMinimumQuote | null;
}

export interface DeliveryMinimumQuote {
    met: boolean;
    /** `order` for an online payment, `shipment` for cash on delivery (one unit per agency). */
    checkedPer: 'order' | 'shipment';
    /** The configured cap: delivery may cost the vendor at most this % of the subtotal. */
    maxDeliveryPercent: number;
    /** How much more is needed from this shop in total; 0 when met. */
    shortfall: number;
    /** One entry per unit checked — a single `agencyId: null` entry for `order`. */
    units: DeliveryCapUnitVerdict[];
}

/**
 * Why cash on delivery is unavailable for a basket — one value per checkout refusal code, 1:1.
 * A client keys its copy on these; checkout still answers with the code (`COD_REASON_BY_CODE`).
 */
export const CASH_ON_DELIVERY_UNAVAILABLE_REASONS = [
    'vendor_not_accepted',
    'agency_not_supported',
    'order_amount_exceeds_limit',
    'digital_items',
] as const;
export type CashOnDeliveryUnavailableReason = (typeof CASH_ON_DELIVERY_UNAVAILABLE_REASONS)[number];

/** The checkout refusal code → the quote's reason. Exhaustive over the four COD refusals. */
export const COD_REASON_BY_CODE: Readonly<Record<string, CashOnDeliveryUnavailableReason>> = {
    [ERROR_CODES.COD_VENDOR_NOT_ACCEPTED]: 'vendor_not_accepted',
    [ERROR_CODES.COD_AGENCY_NOT_SUPPORTED]: 'agency_not_supported',
    [ERROR_CODES.COD_ORDER_AMOUNT_EXCEEDS_LIMIT]: 'order_amount_exceeds_limit',
    [ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL]: 'digital_items',
};

export interface CashOnDeliveryQuote {
    /** `true` when checkout would accept this basket as cash on delivery right now. */
    available: boolean;
    /**
     * The FIRST refusal's reason (shops in cart order). `null` when available — and also when
     * `available` is false because the rules could not be evaluated (a lookup failed): checkout is
     * the authority then, and a client shows a generic line.
     */
    reason: CashOnDeliveryUnavailableReason | null;
    /** Every shop that refuses (already public on `perVendor[].vendorId`). Empty for `digital_items`. */
    vendorIds: string[];
}

/** One refusal, as the pure verdict reads it. `vendorId` is null for the basket-wide digital rule. */
export interface CodRefusal {
    vendorId: string | null;
    error: AppError;
}

/**
 * The pure half of the verdict: refusals → the public shape. `null` means "not evaluated", which
 * is never "available". A refusal whose code is not one of the four (should not happen) still
 * makes COD unavailable, with `reason: null`.
 */
export function cashOnDeliveryVerdictOf(refusals: CodRefusal[] | null): CashOnDeliveryQuote {
    if (refusals === null) return { available: false, reason: null, vendorIds: [] };
    if (refusals.length === 0) return { available: true, reason: null, vendorIds: [] };
    const vendorIds = [...new Set(refusals.map((r) => r.vendorId).filter((id): id is string => !!id))];
    return { available: false, reason: COD_REASON_BY_CODE[refusals[0].error.code] ?? null, vendorIds };
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
    /** The payment method the delivery minimum was evaluated for (the request's, default `online`). */
    paymentMethod: OrderPaymentMethod;
    /**
     * `false` when any shop's `deliveryMinimum.met` is false. A `null` (not evaluated) shop does not
     * make it false — checkout is the authority either way.
     */
    meetsDeliveryMinimum: boolean;
    /**
     * Would checkout accept this basket as cash on delivery (ADR-A09 G-10)? Independent of
     * `paymentMethod`. The delivery minimum is NOT part of it — that is `meetsDeliveryMinimum` on a
     * quote asked with `paymentMethod: 'cash_on_delivery'`.
     */
    cashOnDelivery: CashOnDeliveryQuote;
    perVendor: CartQuoteVendorLine[];
}

type QuotableCart = { items: Array<{ vendorId: string; productId: string; variantId: string; price: number; quantity: number; productType: string }> };

interface CapInput {
    vendorId: string;
    physical: boolean;
    lines: DeliveryCapLine[];
    groups: DeliveryCapAgencyGroup[];
}

export class CartQuoteService {
    constructor(
        private readonly cartService = new CartService(),
        private readonly productRepository = new ProductRepositoryMongo(),
        private readonly vendorRepository = new VendorRepository(),
        private readonly agencyRepository = new DeliveryAgencyRepository(),
        private readonly deliveryCap: DeliveryCostCapService = deliveryCostCapService,
        private readonly codEligibility: CodEligibilityService = codEligibilityService,
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
    async quoteForCustomer(
        customerId: string,
        deliveryAddressId?: string,
        paymentMethod: OrderPaymentMethod = 'online',
    ): Promise<CartQuote> {
        return (await this.quoteWithCodRefusal(customerId, deliveryAddressId, paymentMethod)).quote;
    }

    /**
     * The quote, plus the first cash-on-delivery refusal as the `AppError` checkout would raise
     * (`null` when COD is accepted). For a caller that must THROW the refusal — the Mini App's
     * `cashOnDeliveryRefusal` — so it reads the same verdict the quote publishes.
     *
     * ⚠ A lookup that fails with a non-`AppError` does not fail the quote: `cashOnDelivery` reads
     * `available: false, reason: null` and `codRefusal` is a generic `COD_AGENCY_NOT_SUPPORTED` —
     * "not evaluated" is never "passed".
     */
    async quoteWithCodRefusal(
        customerId: string,
        deliveryAddressId?: string,
        paymentMethod: OrderPaymentMethod = 'online',
    ): Promise<{ quote: CartQuote; codRefusal: AppError | null }> {
        const cart = await this.cartService.getCart(customerId);

        if (cart.items.length === 0) {
            throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 400, 'Cannot quote an empty cart');
        }

        const currency = cart.items[0].currency;
        const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

        if (deliveryAddressId) {
            await this.assertAddressUsable(customerId, deliveryAddressId);
        }

        const inputs = await this.capInputs(cart);
        const perVendor = await this.estimatePerVendor(inputs, paymentMethod);

        let refusals: CodRefusal[] | null;
        try {
            refusals = await this.codRefusalsOf(cart.productType ?? null, inputs, perVendor);
        } catch (error) {
            console.error('[CartQuoteService] Cash-on-delivery eligibility not evaluable:', error);
            refusals = null;
        }
        const codRefusal = refusals === null
            ? createAppError(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 422)
            : refusals[0]?.error ?? null;

        const absorbed = perVendor.every((v) => v.absorbedByVendor === 0) && cart.productType === 'digital'
            ? null
            : perVendor.reduce((sum, v) => sum + v.absorbedByVendor, 0);

        const quote: CartQuote = {
            currency,
            subtotal,
            // The customer pays for the goods. Delivery is the vendor's cost.
            delivery: 0,
            absorbedByVendor: absorbed,
            tax: 0,
            discount: 0,
            total: subtotal,
            paymentMethod,
            meetsDeliveryMinimum: perVendor.every((v) => v.deliveryMinimum?.met ?? true),
            cashOnDelivery: cashOnDeliveryVerdictOf(refusals),
            perVendor,
        };
        return { quote, codRefusal };
    }

    /**
     * Every cash-on-delivery refusal checkout would raise for this basket, shops in cart order.
     *
     * Checkout's rules, through checkout's own call: a non-physical basket is refused outright;
     * each shop's part goes through `assertVendorOrderEligible` with the agencies its shipments
     * would be grouped by and its subtotal (checkout's order total: delivery is the vendor's, tax
     * and discount are pinned to 0). A physical shop with NO resolvable agency is refused as
     * `COD_AGENCY_NOT_SUPPORTED` — checkout refuses it either way (`ORDER_NO_DELIVERY_AGENCY`).
     * Non-`AppError` failures propagate; the caller turns them into "not evaluated".
     */
    private async codRefusalsOf(
        productType: string | null,
        inputs: CapInput[],
        perVendor: CartQuoteVendorLine[],
    ): Promise<CodRefusal[]> {
        if (productType !== 'physical') {
            return [{
                vendorId: null,
                error: createAppError(ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL, 422, 'Cash on delivery is only available for physical orders'),
            }];
        }

        const refusals: CodRefusal[] = [];
        for (const input of inputs) {
            if (!input.physical) continue;
            const agencyIds = input.groups.map((g) => g.agencyId);
            if (agencyIds.length === 0) {
                refusals.push({
                    vendorId: input.vendorId,
                    error: createAppError(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 422, undefined, { vendorId: input.vendorId }),
                });
                continue;
            }
            const subtotal = perVendor.find((v) => v.vendorId === input.vendorId)?.subtotal
                ?? input.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
            try {
                await this.codEligibility.assertVendorOrderEligible({
                    orderType: 'physical',
                    totalAmount: subtotal,
                    agencyIds,
                    vendorId: input.vendorId,
                });
            } catch (error) {
                if (!(error instanceof AppError)) throw error;
                refusals.push({ vendorId: input.vendorId, error });
            }
        }
        return refusals;
    }

    /**
     * Refuse a cart checkout would refuse for its delivery minimum — the chat door's pre-spend
     * check. Same service, same verdict as `perVendor[].deliveryMinimum`; `extraDetails` carries
     * the caller's protocol fields (`spent: false`).
     */
    async assertDeliveryMinimum(
        cart: { items: Array<QuotableCart['items'][number] & { currency: string }> },
        paymentMethod: OrderPaymentMethod,
        extraDetails: Record<string, unknown> = {},
    ): Promise<void> {
        if (cart.items.length === 0) return;
        const currency = cart.items[0].currency;
        for (const input of await this.capInputs(cart)) {
            if (!input.physical) continue;
            const verdict = await this.deliveryCap.assessVendor(input, paymentMethod);
            if (!verdict.met) throw belowMinimumError(verdict, currency, extraDetails);
        }
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
    private async estimatePerVendor(inputs: CapInput[], paymentMethod: OrderPaymentMethod): Promise<CartQuoteVendorLine[]> {
        const lines: CartQuoteVendorLine[] = [];

        for (const input of inputs) {
            const subtotal = input.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

            // Digital lines never ship, so they carry no delivery cost at all.
            if (!input.physical) {
                lines.push({ vendorId: input.vendorId, subtotal, delivery: 0, absorbedByVendor: 0, deliveryMinimum: null });
                continue;
            }

            let absorbedByVendor = 0;
            for (const group of input.groups) {
                if (!Types.ObjectId.isValid(group.agencyId)) continue;
                const agency = await this.agencyRepository.findById(group.agencyId);
                // No policies means no quotable price. `computeShipmentDeliveryFee` falls
                // back to a constant and logs loudly at split time; an estimate must not
                // invent a number, so this contributes nothing.
                if (!agency?.policies) continue;
                absorbedByVendor += deliveryFeeForPickupMix(agency.policies, group.mix);
            }

            // Same reasoning as a missing agency above: a vendor whose plan cannot be resolved
            // (`BILLING_PLAN_NOT_FOUND`) is a misconfiguration the shopper cannot act on, so
            // the quote reports "not estimated" (`null`) rather than failing the cart page.
            // Checkout still refuses — the split would fail on the same lookup.
            let deliveryMinimum: DeliveryMinimumQuote | null = null;
            try {
                const verdict = await this.deliveryCap.assessVendor(input, paymentMethod);
                deliveryMinimum = {
                    met: verdict.met,
                    checkedPer: verdict.scope,
                    maxDeliveryPercent: verdict.maxDeliveryPercent,
                    shortfall: verdict.shortfall,
                    units: verdict.units,
                };
            } catch (error) {
                console.error(`[CartQuoteService] Delivery minimum not estimable for vendor ${input.vendorId}:`, error);
            }

            lines.push({
                vendorId: input.vendorId,
                subtotal,
                delivery: 0,
                absorbedByVendor,
                deliveryMinimum,
            });
        }

        return lines;
    }

    /**
     * The cart grouped per vendor, then per agency — the shape both the fee estimate and the
     * delivery minimum read. The pickup mix comes from the product's live configuration;
     * checkout snapshots that same field and the split classifies the snapshot.
     */
    private async capInputs(cart: QuotableCart): Promise<CapInput[]> {
        const byVendor = new Map<string, QuotableCart['items']>();
        for (const item of cart.items) {
            const group = byVendor.get(item.vendorId) ?? [];
            group.push(item);
            byVendor.set(item.vendorId, group);
        }

        const out: CapInput[] = [];

        // The vendor's minimum per bargainable line, so the vendor-net half of the cap counts the
        // bargain fee checkout will deduct. Server-side only — a floor never reaches the quote body.
        const floors = await bargainFloorsForVariants(cart.items);
        const capLineOf = (i: QuotableCart['items'][number]): DeliveryCapLine =>
            ({ unitPrice: i.price, quantity: i.quantity, floorPrice: floors.get(i.variantId) ?? null });

        for (const [vendorId, items] of byVendor) {
            const lines = items.map(capLineOf);

            if (items.every((i) => i.productType !== 'physical')) {
                out.push({ vendorId, physical: false, lines, groups: [] });
                continue;
            }

            const vendor = await this.vendorRepository.findById(vendorId);
            const vendorDefaultAgencyId = vendor?.default_delivery_agency_id?.toString() ?? null;

            // agencyId → the shipment it will receive.
            const byAgency = new Map<string, DeliveryCapAgencyGroup>();

            for (const item of items) {
                const product = await this.productRepository.findByIdUnscoped(item.productId);
                if (!product || product.type !== 'physical') continue;

                const agencyId = resolveEffectiveAgencyId(product, vendorDefaultAgencyId);
                // No resolvable agency is not an error here — checkout raises
                // ORDER_NO_DELIVERY_AGENCY for it. A quote that threw would block the cart
                // page over a misconfiguration the shopper cannot act on.
                if (!agencyId || !Types.ObjectId.isValid(agencyId)) continue;

                const group = byAgency.get(agencyId)
                    ?? { agencyId, mix: { hasPickupBased: false, hasStorageBased: false }, lines: [] };
                const source = product.delivery?.pickupLocation?.source;
                if (source === 'vendor_address') group.mix.hasPickupBased = true;
                if (source === 'agency_storage') group.mix.hasStorageBased = true;
                group.lines.push(capLineOf(item));
                byAgency.set(agencyId, group);
            }

            out.push({ vendorId, physical: true, lines, groups: [...byAgency.values()] });
        }

        return out;
    }
}

export const cartQuoteService = new CartQuoteService();
