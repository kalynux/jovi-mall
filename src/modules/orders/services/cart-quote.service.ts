/**
 * What a cart will cost, quoted before checkout.
 *
 * ── Who pays delivery (ADR-A11, customer-paid delivery, 2026-10-03) ─────────
 *
 * Free delivery is a SHOP setting (`always` · `never` · `above` a threshold, default `always`).
 * Per shop part of the basket:
 *
 *     vendor-paid    delivery = 0, the fee is reported as `absorbedByVendor` (informational)
 *     customer-paid  delivery = Σ that shop's shipment fees, added to `total`
 *
 *     total = subtotal + Σ customer-paid delivery        (tax and discount are pinned 0)
 *
 * A free-delivery shop part that cannot carry its fee (the ADR-A07 30% cap) is NOT refused any
 * more — it falls back to customer-paid (`deliveryPayerReason: 'cap_fallback'`, D-6), and
 * `freeDelivery.shortfall` says how much more from that shop would make delivery free.
 *
 * ── Why the quote cannot drift from the charge ──────────────────────────────
 *
 * Every figure here comes from `VendorOrderPricingService` → `priceVendorOrder` — THE function
 * checkout prices with (same line resolution, same grouping into one shipment per agency, same
 * formula with weight and region, same payer rule, same cap). This service only shapes the
 * result. `test:customer-delivery-fee` source-scans both callers for it.
 *
 * ⚠️ It is still an ESTIMATE, and three things can move it between quote and checkout: an
 * agency editing `policies.pricing`, a vendor re-pointing a product's agency or editing their
 * delivery terms, and the drop-off. The drop-off is the requested `deliveryAddressId`'s, else the
 * customer's default saved address — the same fallback checkout applies — and `regionKnown:
 * false` says no region could be read (every shipment is then priced in-region, never guessed
 * against the customer). Checkout is the authority.
 *
 * ── The delivery minimum (ADR-A07 → A10) ────────────────────────────────────
 *
 * `perVendor[].deliveryMinimum` is the check checkout REFUSES on. Since ADR-A11 it can fail only
 * when even customer-paid delivery leaves the vendor earning ≤ 0 (commission + bargain fee + the
 * COD handling fee, which stays the vendor's — D-5). Its shape is unchanged so existing clients
 * keep working; "add X for free delivery" is `freeDelivery.shortfall`, not this.
 *
 * ── Whether cash on delivery is possible is quoted too (ADR-A09 G-10, 2026-10-03) ──
 *
 * `cashOnDelivery` answers "would checkout refuse this basket as COD?" BEFORE the pay screen, on
 * every quote whatever `paymentMethod` was asked. The rule is checkout's own:
 * `codEligibilityService.assertVendorOrderEligible` — vendor COD terms first, then each carrying
 * agency (COD-capable + verified, order within its per-order maximum) — fed the agencies the cart
 * groups each shop's shipments by and the shop's COD-priced total (items + customer-paid
 * delivery: cash the agent carries). The Mini App's `cashOnDeliveryRefusal` reads the SAME
 * refusal (`quoteWithCodRefusal`), so the web shop and the bot cannot disagree. The verdict
 * carries a reason and the refusing shops' ids only; no vendor setting or agency limit leaves.
 * ⚠ The COD exposure limits (agency / vendor holds) are deliberately NOT here: a hold never
 * refuses the customer — the order is placed and held for the vendor.
 */
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CartService } from '../../cart/services/cart.service';
import { CustomerModel } from '../../customers/customer.model';
import { OrderPaymentMethod } from '../order.model';
import { CodEligibilityService, codEligibilityService } from '../../cod/services/cod-eligibility.service';
import { bargainFloorsForVariants } from '../../catalog/read-models/display-price.lookup';
import { DeliveryCapUnitVerdict, DeliveryCostUnitsVerdict } from '../../earnings/services/delivery-cost-cap';
import { ShipmentFeeComponents } from '../../earnings/domain/delivery-pricing';
import {
    DeliveryPayer,
    DeliveryPayerReason,
    VendorDeliveryTermsMode,
} from '../../vendors/domain/delivery-terms';
import { PricingLine, VendorOrderPricing } from '../domain/vendor-order-pricing';
import { belowMinimumError } from './delivery-cost-cap.service';
import {
    regionOfGeo,
    VendorOrderPricingService,
    vendorOrderPricingService,
} from './vendor-order-pricing.service';

/** One shipment the shop's part will become (= one agency), as quoted. */
export interface CartQuoteShipmentLine {
    agencyId: string;
    /** Σ unit weight × qty, grams — what the fee's per-kilogram part reads. */
    weightGrams: number;
    outOfRegion: boolean;
    fee: number;
    /** The formula's itemisation; `null` when the agency has no pricing policy (flat fallback). */
    components: ShipmentFeeComponents | null;
}

export interface CartQuoteFreeDelivery {
    /** The shop's terms: `always` (free), `never` (customer pays), `above` (free from a threshold). */
    mode: VendorDeliveryTermsMode;
    /** The threshold when `mode === 'above'`, else null. */
    freeAboveAmount: number | null;
    /**
     * How much more from THIS shop would make delivery free — the threshold's gap, or what the
     * 30% cap needs when a free-delivery shop fell back (`cap_fallback`). `null` when delivery is
     * already free, when the shop never delivers free, or when no basket size can make it free.
     */
    shortfall: number | null;
}

export interface CartQuoteVendorLine {
    vendorId: string;
    /** This shop's items. */
    subtotal: number;
    /** What the CUSTOMER pays for this shop's delivery (0 when the shop pays). */
    delivery: number;
    /** `subtotal + delivery`. */
    total: number;
    /** Who pays this shop part's delivery. `null` for a digital-only shop (no delivery). */
    deliveryPayer: DeliveryPayer | null;
    deliveryPayerReason: DeliveryPayerReason | null;
    /** What this vendor will be charged by the agency (vendor-paid only). Informational. */
    absorbedByVendor: number;
    /** `null` for a digital-only shop. */
    freeDelivery: CartQuoteFreeDelivery | null;
    /** One line per shipment checkout would create. Empty for a digital-only shop. */
    shipments: CartQuoteShipmentLine[];
    /**
     * Whether checkout would accept this shop's part (the ADR-A07 cap when the shop pays — a
     * failure falls back to customer-paid — and `vendorNet > 0` when the customer pays). When
     * `met` is false, checkout refuses with `ORDER_BELOW_DELIVERY_MINIMUM`. `null` means NOT
     * EVALUATED — a digital-only shop, or a vendor whose plan could not be resolved.
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
    /** The items. */
    subtotal: number;
    /** What the customer is charged for delivery: Σ customer-paid shops' fees (ADR-A11). */
    delivery: number;
    /**
     * The agencies' delivery fees the VENDORS will pay (free-delivery shops). Informational.
     * `null` for a digital cart (no delivery) — deliberately distinct from `0` ("estimated, and
     * the shops pay nothing").
     */
    absorbedByVendor: number | null;
    /** Pinned to 0: there is no tax engine. Quoted rather than hardcoded at the call site. */
    tax: number;
    /** Pinned to 0: there is no coupon model. `price_breakdown.discount` awaits one. */
    discount: number;
    /** `subtotal + delivery + tax − discount` — what checkout will charge. */
    total: number;
    /** The payment method the quote was priced for (the request's, default `online`). */
    paymentMethod: OrderPaymentMethod;
    /**
     * Whether a drop-off region could be read (the requested address, else the default saved
     * one). `false` ⇒ every shipment was priced in-region; checkout prices against the address
     * actually chosen.
     */
    regionKnown: boolean;
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

type QuotableItem = {
    vendorId: string;
    productId: string;
    variantId: string;
    price: number;
    quantity: number;
    productType: string;
    title?: string;
};
type QuotableCart = { items: QuotableItem[] };

/** One shop's part, resolved for pricing. `groups` are the agencies its shipments would go to. */
interface QuoteInput {
    vendorId: string;
    physical: boolean;
    lines: PricingLine[];
    groups: Array<{ agencyId: string }>;
}

/** One shop's part, priced for every payment method the quote needs. */
interface PricedVendor {
    input: QuoteInput;
    byMethod: Map<OrderPaymentMethod, VendorOrderPricing>;
}

export class CartQuoteService {
    constructor(
        private readonly cartService = new CartService(),
        private readonly pricing: VendorOrderPricingService = vendorOrderPricingService,
        private readonly codEligibility: CodEligibilityService = codEligibilityService,
    ) { }

    /**
     * Quote the caller's current cart.
     *
     * `deliveryAddressId` is VALIDATED (the one chance to tell a shopper their address is
     * unusable before checkout refuses it) and its region prices the out-of-region surcharge.
     * Without it the default saved address is used, as checkout does.
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

        const deliveryRegion = deliveryAddressId
            ? await this.assertAddressUsable(customerId, deliveryAddressId)
            : await this.defaultAddressRegion(customerId);

        // Online and COD can price differently (the cap's unit differs), and the COD verdict is
        // always asked — so price both, from one load of the facts.
        const methods: OrderPaymentMethod[] = paymentMethod === 'cash_on_delivery'
            ? ['cash_on_delivery']
            : ['online', 'cash_on_delivery'];
        const priced = await this.priceVendors(await this.quoteInputs(cart), deliveryRegion, methods, 'lenient');
        const perVendor = priced.map((p) => this.toVendorLine(p, paymentMethod));

        let refusals: CodRefusal[] | null;
        try {
            refusals = await this.codRefusalsOf(
                cart.productType ?? null,
                priced.map((p) => p.input),
                priced.map((p) => ({
                    vendorId: p.input.vendorId,
                    subtotal: p.byMethod.get('cash_on_delivery')?.total ?? lineSubtotal(p.input.lines),
                })),
            );
        } catch (error) {
            console.error('[CartQuoteService] Cash-on-delivery eligibility not evaluable:', error);
            refusals = null;
        }
        const codRefusal = refusals === null
            ? createAppError(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 422)
            : refusals[0]?.error ?? null;

        const delivery = perVendor.reduce((sum, v) => sum + v.delivery, 0);
        const absorbed = cart.productType === 'digital'
            ? null
            : perVendor.reduce((sum, v) => sum + v.absorbedByVendor, 0);

        const quote: CartQuote = {
            currency,
            subtotal,
            delivery,
            absorbedByVendor: absorbed,
            tax: 0,
            discount: 0,
            total: subtotal + delivery,
            paymentMethod,
            regionKnown: deliveryRegion !== null,
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
     * would be grouped by and its COD-priced total (`perVendor[].subtotal` here carries the
     * shop's total INCLUDING customer-paid delivery — cash the agent carries, ADR-A11). A physical
     * shop with NO resolvable agency is refused as `COD_AGENCY_NOT_SUPPORTED` — checkout refuses
     * it either way (`ORDER_NO_DELIVERY_AGENCY`). Non-`AppError` failures propagate; the caller
     * turns them into "not evaluated".
     */
    private async codRefusalsOf(
        productType: string | null,
        inputs: Array<Pick<QuoteInput, 'vendorId' | 'physical' | 'groups'> & { lines: Array<{ unitPrice: number; quantity: number }> }>,
        perVendor: Array<{ vendorId: string; subtotal: number }>,
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
     * check. Same pricing path, same verdict as `perVendor[].deliveryMinimum`; `extraDetails`
     * carries the caller's protocol fields (`spent: false`). Since ADR-A11 it refuses only when
     * even customer-paid delivery leaves the vendor ≤ 0 (a free-delivery shop that cannot carry
     * its fee falls back to customer-paid instead).
     */
    async assertDeliveryMinimum(
        cart: { items: Array<QuotableItem & { currency: string }> },
        paymentMethod: OrderPaymentMethod,
        extraDetails: Record<string, unknown> = {},
    ): Promise<void> {
        if (cart.items.length === 0) return;
        const currency = cart.items[0].currency;
        // The refusal does not depend on the drop-off (the vendor's net under customer-paid
        // delivery carries no fee), so no region is needed here.
        const priced = await this.priceVendors(await this.quoteInputs(cart), null, [paymentMethod], 'strict');
        for (const p of priced) {
            const minimum = p.byMethod.get(paymentMethod)?.deliveryMinimum;
            if (minimum && !minimum.met) throw belowMinimumError({ vendorId: p.input.vendorId, ...minimum }, currency, extraDetails);
        }
    }

    /**
     * Reject an address the checkout would reject, at the moment the shopper can still fix it.
     * Raises the same `ORDER_DELIVERY_ADDRESS_REQUIRED` (422) checkout does. Returns its region.
     */
    private async assertAddressUsable(customerId: string, addressId: string): Promise<string | null> {
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
        return regionOfGeo(chosen.geo as any);
    }

    /** The default saved address's region — checkout's own fallback (`resolveDeliveryAddress`). */
    private async defaultAddressRegion(customerId: string): Promise<string | null> {
        const customer = await CustomerModel.findById(customerId).select('saved_addresses').lean().exec();
        const addresses = customer?.saved_addresses ?? [];
        const fallback = addresses.find((a) => a.is_default) ?? addresses[0] ?? null;
        return regionOfGeo((fallback?.geo ?? null) as any);
    }

    /**
     * The cart grouped per vendor, each line resolved exactly as checkout resolves it
     * (`VendorOrderPricingService.resolveDeliveryLines`, lenient: a line with no resolvable
     * agency rides no shipment rather than failing the cart page — checkout refuses it).
     */
    private async quoteInputs(cart: QuotableCart): Promise<QuoteInput[]> {
        const byVendor = new Map<string, QuotableItem[]>();
        for (const item of cart.items) {
            const group = byVendor.get(item.vendorId) ?? [];
            group.push(item);
            byVendor.set(item.vendorId, group);
        }

        // The vendor's minimum per bargainable line, so the vendor-net half of the cap counts the
        // bargain fee checkout will deduct. Server-side only — a floor never reaches the quote body.
        const floors = await bargainFloorsForVariants(cart.items);

        const out: QuoteInput[] = [];
        for (const [vendorId, items] of byVendor) {
            const physical = items.some((i) => i.productType === 'physical');
            const facts = physical
                ? await this.pricing.resolveDeliveryLines(
                    items.map((i) => ({ productId: i.productId, variantId: i.variantId, vendorId: i.vendorId, title: i.title })),
                    'lenient',
                )
                : items.map(() => null);
            const lines: PricingLine[] = items.map((item, index) => {
                const fact = facts[index];
                return {
                    unitPrice: item.price,
                    quantity: item.quantity,
                    floorPrice: floors.get(item.variantId) ?? null,
                    agencyId: fact?.agencyId ?? null,
                    pickupSource: fact?.pickupLocation?.source ?? null,
                    pickupRegion: fact?.pickupRegion ?? null,
                    unitWeightGrams: fact?.weight.grams ?? 0,
                };
            });
            const agencyIds = [...new Set(lines.map((l) => l.agencyId).filter((id): id is string => !!id))];
            out.push({ vendorId, physical, lines, groups: agencyIds.map((agencyId) => ({ agencyId })) });
        }
        return out;
    }

    private async priceVendors(
        inputs: QuoteInput[],
        deliveryRegion: string | null,
        methods: OrderPaymentMethod[],
        mode: 'strict' | 'lenient',
    ): Promise<PricedVendor[]> {
        const out: PricedVendor[] = [];
        for (const input of inputs) {
            if (!input.physical) {
                out.push({ input, byMethod: new Map() });
                continue;
            }
            const byMethod = await this.pricing.priceMethods(
                { vendorId: input.vendorId, deliveryRegion, lines: input.lines },
                methods,
                mode,
            );
            out.push({ input, byMethod });
        }
        return out;
    }

    /** Shape one shop's pricing for the wire. */
    private toVendorLine(p: PricedVendor, paymentMethod: OrderPaymentMethod): CartQuoteVendorLine {
        const subtotal = lineSubtotal(p.input.lines);
        const pricing = p.byMethod.get(paymentMethod);
        if (!pricing) {
            // Digital lines never ship, so they carry no delivery at all.
            return {
                vendorId: p.input.vendorId,
                subtotal,
                delivery: 0,
                total: subtotal,
                deliveryPayer: null,
                deliveryPayerReason: null,
                absorbedByVendor: 0,
                freeDelivery: null,
                shipments: [],
                deliveryMinimum: null,
            };
        }
        return {
            vendorId: p.input.vendorId,
            subtotal,
            delivery: pricing.deliveryCharged,
            total: pricing.total,
            deliveryPayer: pricing.payer,
            deliveryPayerReason: pricing.payerReason,
            absorbedByVendor: pricing.absorbedByVendor,
            freeDelivery: {
                mode: pricing.terms.mode,
                freeAboveAmount: pricing.terms.freeAboveAmount,
                shortfall: pricing.payer === 'customer' ? pricing.freeDeliveryShortfall : null,
            },
            shipments: pricing.shipments.map((s) => ({
                agencyId: s.agencyId,
                weightGrams: s.weightGrams,
                outOfRegion: s.outOfRegion,
                fee: s.fee,
                components: s.components,
            })),
            deliveryMinimum: toMinimumQuote(pricing.deliveryMinimum),
        };
    }
}

function lineSubtotal(lines: Array<{ unitPrice: number; quantity: number }>): number {
    return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

function toMinimumQuote(verdict: DeliveryCostUnitsVerdict | null): DeliveryMinimumQuote | null {
    if (!verdict) return null;
    return {
        met: verdict.met,
        checkedPer: verdict.scope,
        maxDeliveryPercent: verdict.maxDeliveryPercent,
        shortfall: verdict.shortfall,
        units: verdict.units,
    };
}

export const cartQuoteService = new CartQuoteService();
