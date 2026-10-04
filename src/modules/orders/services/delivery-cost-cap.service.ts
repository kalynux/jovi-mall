/**
 * The delivery-cost cap, applied to a basket (ADR-A07).
 *
 * ⚠ ADR-A11 (customer-paid delivery, 2026-10-03) moved the checkout and the cart quote onto
 * `VendorOrderPricingService` → `priceVendorOrder`, which forms the units with the SAME pure
 * function this service uses (`assessDeliveryCostUnits`) and runs the cap ONLY for a vendor-paid
 * shop part — a failure there falls back to customer-paid instead of refusing (D-6). This
 * service survives as the mix-priced, vendor-paid evaluation for any caller that has no
 * weight/region facts; it no longer sits on the checkout path.
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
 * A group's `fee` when the caller priced it (THE formula, weight + region); else
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
import {
    assessDeliveryCostUnits,
    DeliveryCapLine,
    DeliveryCapUnitVerdict,
} from '../../earnings/services/delivery-cost-cap';
import { OrderPaymentMethod } from '../order.model';

export type { DeliveryCapLine, DeliveryCapUnitVerdict };

/** The lines one agency will carry for this vendor — one shipment at checkout. */
export interface DeliveryCapAgencyGroup {
    agencyId: string;
    mix: PickupMix;
    lines: DeliveryCapLine[];
    /**
     * The shipment's fee when the caller already priced it (weight, region — ADR-A11). Absent ⇒
     * `deliveryFeeForPickupMix` (1 kg, in-region) or the flat fallback, as before.
     */
    fee?: number;
}

export interface DeliveryCapVendorInput {
    vendorId: string;
    /**
     * EVERY line of the vendor's order, including any that joined no agency group. The online
     * unit's subtotal is the order's items subtotal, which is what `splitOrder` reads as gross.
     */
    lines: DeliveryCapLine[];
    groups: DeliveryCapAgencyGroup[];
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

export class DeliveryCostCapService {
    constructor(
        private readonly agencyRepository = new DeliveryAgencyRepository(),
        private readonly entitlements: EntitlementService = entitlementService,
    ) { }

    /**
     * Evaluate one vendor's part of a PHYSICAL basket as VENDOR-paid (the ADR-A07 cap). The
     * units and the arithmetic are `assessDeliveryCostUnits` — the same function checkout's
     * pricing path (`priceVendorOrder`) calls.
     */
    async assessVendor(
        input: DeliveryCapVendorInput,
        paymentMethod: OrderPaymentMethod,
    ): Promise<DeliveryCapVendorVerdict> {
        const { commissionPercent } = await this.entitlements.getEntitlements(input.vendorId);

        const agencyIds = [...new Set(input.groups.map((g) => g.agencyId))];
        const agencies = agencyIds.length > 0 ? await this.agencyRepository.findByIds(agencyIds) : [];
        const policiesById = new Map<string, IAgencyPolicies | null>(
            agencies.map((a) => [String(a._id), a.policies ?? null]),
        );

        const feeFor = (group: DeliveryCapAgencyGroup): number => {
            if (typeof group.fee === 'number') return group.fee;
            const policies = policiesById.get(group.agencyId) ?? null;
            return policies ? deliveryFeeForPickupMix(policies, group.mix) : EARNINGS_CONFIG.DELIVERY_FLAT_FEE;
        };

        const verdict = assessDeliveryCostUnits({
            lines: input.lines,
            groups: input.groups.map((g) => ({
                agencyId: g.agencyId,
                fee: feeFor(g),
                codHandling: policiesById.get(g.agencyId)?.pricing?.additional_fees?.cod_handling_fee ?? null,
                lines: g.lines,
            })),
            commissionPercent,
            paymentMethod,
            customerPaysDelivery: false,
        });

        return { vendorId: input.vendorId, ...verdict };
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
