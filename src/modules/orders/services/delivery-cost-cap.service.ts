/**
 * The delivery-cost cap, applied to a basket (ADR-A07).
 *
 * `delivery-cost-cap.ts` holds the arithmetic for ONE unit. This service decides what the
 * units ARE, loads what the arithmetic needs (each agency's pricing, the vendor's commission)
 * and refuses. It has three callers and they must stay on this one path:
 *
 *   - `OrderService.buildVendorOrder`  — authoritative, inside the checkout transaction, with
 *                                        the negotiated prices and floors (exact AI margin).
 *   - `CartQuoteService`               — the same verdict before checkout, so a client can say
 *                                        "add X from this shop" instead of failing at pay.
 *   - the chat checkout's pre-spend check — refuses while the checkout handle is still alive.
 *
 * ── The unit is the SPLIT's unit, not a free choice ──────────────────────────
 * The rule exists to keep `EarningsSplitService` from refusing money that has already moved,
 * so it must be evaluated over exactly what that split divides:
 *
 *   online → ONE unit per vendor order. `splitOrder` subtracts every shipment's fee from the
 *            order's gross in one sum.
 *   COD    → ONE unit per shipment (= per agency at checkout). `splitCodCollection` splits each
 *            cash collection on that shipment's slice alone, and charges the COD handling fee
 *            per collection. A small shipment inside a large COD order still fails.
 *
 * ── The fee is the split's fee ───────────────────────────────────────────────
 * `deliveryFeeForPickupMix` for an agency with a pricing policy, `EARNINGS_CONFIG.
 * DELIVERY_FLAT_FEE` for one without — the same fallback `computeShipmentDeliveryFee` charges.
 */
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import { EARNINGS_CONFIG } from '../../earnings/config/earnings.config';
import { deliveryFeeForPickupMix, PickupMix } from '../../earnings/services/earnings-quote.service';
import { computeNegotiatedLineSplit } from '../../earnings/services/negotiation-margin.service';
import {
    DeliveryCostCapFailure,
    evaluateDeliveryCostCap,
    resolveMaxDeliveryPercent,
} from '../../earnings/services/delivery-cost-cap';
import { OrderPaymentMethod } from '../order.model';

/** One priced line. `floorPrice` on every line of a bargainable variant (the bargain fee is owed haggled or not). */
export interface DeliveryCapLine {
    unitPrice: number;
    quantity: number;
    floorPrice?: number | null;
}

/** The lines one agency will carry for this vendor — one shipment at checkout. */
export interface DeliveryCapAgencyGroup {
    agencyId: string;
    mix: PickupMix;
    lines: DeliveryCapLine[];
}

export interface DeliveryCapVendorInput {
    vendorId: string;
    /**
     * EVERY line of the vendor's order, including any that joined no agency group. The online
     * unit's subtotal is the order's `total_amount`, which is what `splitOrder` reads as gross.
     */
    lines: DeliveryCapLine[];
    groups: DeliveryCapAgencyGroup[];
}

/** One evaluated unit — safe to show a customer: no commission, no net, no fee breakdown. */
export interface DeliveryCapUnitVerdict {
    /** `null` on an online order, which spans every agency. */
    agencyId: string | null;
    subtotal: number;
    met: boolean;
    reason: DeliveryCostCapFailure | null;
    minimumSubtotal: number | null;
    shortfall: number;
}

export interface DeliveryCapVendorVerdict {
    vendorId: string;
    scope: 'order' | 'shipment';
    maxDeliveryPercent: number;
    met: boolean;
    /** Online: the order's shortfall. COD: the sum over failing shipments (each needs its own). */
    shortfall: number;
    units: DeliveryCapUnitVerdict[];
}

const lineSubtotal = (lines: DeliveryCapLine[]) =>
    lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

const lineAiMargin = (lines: DeliveryCapLine[]) =>
    lines.reduce(
        (sum, l) => sum + computeNegotiatedLineSplit({ unitPrice: l.unitPrice, floorPrice: l.floorPrice, quantity: l.quantity }).aiMargin,
        0,
    );

export class DeliveryCostCapService {
    constructor(
        private readonly agencyRepository = new DeliveryAgencyRepository(),
        private readonly entitlements: EntitlementService = entitlementService,
    ) { }

    /** Evaluate one vendor's part of a PHYSICAL basket. */
    async assessVendor(
        input: DeliveryCapVendorInput,
        paymentMethod: OrderPaymentMethod,
    ): Promise<DeliveryCapVendorVerdict> {
        const maxDeliveryPercent = resolveMaxDeliveryPercent();
        const { commissionPercent } = await this.entitlements.getEntitlements(input.vendorId);

        const agencyIds = [...new Set(input.groups.map((g) => g.agencyId))];
        const agencies = agencyIds.length > 0 ? await this.agencyRepository.findByIds(agencyIds) : [];
        const policiesById = new Map<string, IAgencyPolicies | null>(
            agencies.map((a) => [String(a._id), a.policies ?? null]),
        );

        const feeFor = (group: DeliveryCapAgencyGroup): number => {
            const policies = policiesById.get(group.agencyId) ?? null;
            return policies ? deliveryFeeForPickupMix(policies, group.mix) : EARNINGS_CONFIG.DELIVERY_FLAT_FEE;
        };

        let units: DeliveryCapUnitVerdict[];
        let scope: DeliveryCapVendorVerdict['scope'];

        if (paymentMethod === 'cash_on_delivery') {
            scope = 'shipment';
            units = input.groups.map((group) => {
                const policies = policiesById.get(group.agencyId) ?? null;
                const verdict = evaluateDeliveryCostCap({
                    subtotal: lineSubtotal(group.lines),
                    aiMargin: lineAiMargin(group.lines),
                    commissionPercent,
                    deliveryFee: feeFor(group),
                    codHandling: policies?.pricing?.additional_fees?.cod_handling_fee ?? null,
                    maxDeliveryPercent,
                });
                return toUnit(group.agencyId, verdict);
            });
        } else {
            scope = 'order';
            const verdict = evaluateDeliveryCostCap({
                subtotal: lineSubtotal(input.lines),
                aiMargin: lineAiMargin(input.lines),
                commissionPercent,
                deliveryFee: input.groups.reduce((sum, g) => sum + feeFor(g), 0),
                codHandling: null,
                maxDeliveryPercent,
            });
            units = [toUnit(null, verdict)];
        }

        return {
            vendorId: input.vendorId,
            scope,
            maxDeliveryPercent,
            met: units.every((u) => u.met),
            shortfall: units.reduce((sum, u) => sum + u.shortfall, 0),
            units,
        };
    }

    /**
     * Refuse the first failing unit with `ORDER_BELOW_DELIVERY_MINIMUM` (422).
     *
     * `extraDetails` lets a caller add its own protocol fields — the chat door's `spent: false`.
     */
    async assertVendor(
        input: DeliveryCapVendorInput,
        paymentMethod: OrderPaymentMethod,
        currency: string,
        extraDetails: Record<string, unknown> = {},
    ): Promise<void> {
        const verdict = await this.assessVendor(input, paymentMethod);
        if (verdict.met) return;
        throw belowMinimumError(verdict, currency, extraDetails);
    }
}

function toUnit(agencyId: string | null, v: ReturnType<typeof evaluateDeliveryCostCap>): DeliveryCapUnitVerdict {
    return {
        agencyId,
        subtotal: v.subtotal,
        met: v.met,
        reason: v.failure,
        minimumSubtotal: v.minimumSubtotal,
        shortfall: v.shortfall,
    };
}

/**
 * The refusal. ⚠ `details` carries only what the customer can act on — never the commission,
 * the vendor's net or the fee breakdown, which are the vendor's business terms.
 */
export function belowMinimumError(
    verdict: DeliveryCapVendorVerdict,
    currency: string,
    extraDetails: Record<string, unknown> = {},
) {
    const unit = verdict.units.find((u) => !u.met)!;
    const need = unit.minimumSubtotal === null
        ? 'it cannot be delivered at any basket size under the current delivery pricing'
        : `at least ${unit.minimumSubtotal} ${currency} is needed (add ${unit.shortfall})`;
    return createAppError(
        ERROR_CODES.ORDER_BELOW_DELIVERY_MINIMUM,
        422,
        `This shop's items come to ${unit.subtotal} ${currency}, below the minimum for delivery: ${need}.`,
        {
            vendorId: verdict.vendorId,
            scope: verdict.scope,
            agencyId: unit.agencyId,
            subtotal: unit.subtotal,
            minimumSubtotal: unit.minimumSubtotal,
            shortfall: unit.shortfall,
            maxDeliveryPercent: verdict.maxDeliveryPercent,
            reason: unit.reason,
            currency,
            ...extraDetails,
        },
    );
}

export const deliveryCostCapService = new DeliveryCostCapService();
