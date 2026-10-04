import type { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import {
  computeShipmentFee,
  isOutOfRegion,
  PickupMix,
  ShipmentFeeComponents,
  shipmentWeightGrams,
} from '../../earnings/domain/delivery-pricing';
import {
  assessDeliveryCostUnits,
  DeliveryCapLine,
  DeliveryCostUnitsVerdict,
} from '../../earnings/services/delivery-cost-cap';
import {
  DeliveryPayer,
  DeliveryPayerReason,
  resolveDeliveryPayer,
  VendorDeliveryTerms,
} from '../../vendors/domain/delivery-terms';

/**
 * What ONE vendor's part of a basket costs, and who pays its delivery — the pure core of
 * ADR-A11 (customer-paid delivery, 2026-10-03).
 *
 * ⭐ **The cart quote and checkout both reach this function**, through
 * `VendorOrderPricingService` (which only loads the facts). That is the whole parity
 * guarantee: a quote that disagrees with the charge is worse than no quote, and two copies of
 * this logic would drift. `test:customer-delivery-fee` scans both callers for it.
 *
 * ── The steps, in order ──────────────────────────────────────────────────────
 *   1. One shipment per AGENCY (the checkout's grouping). Each is priced by THE formula
 *      (`computeShipmentFee`: weight of its lines × qty, out-of-region when any line's pickup
 *      region is known and differs from the drop-off's; the agency's ceiling). An agency with no
 *      pricing policy charges `flatFeeFallback` (`EARNINGS_DELIVERY_FLAT_FEE`, default 0) —
 *      the same fallback the split has always charged.
 *   2. Who pays: the shop's terms (`resolveDeliveryPayer`) on the items subtotal.
 *   3. D-6: a VENDOR-paid part runs the ADR-A07 cap (online per order, COD per shipment). A
 *      failure does not refuse — the part falls back to CUSTOMER-paid
 *      (`cap_fallback`), and `freeDeliveryShortfall` is what the cap needs added.
 *   4. A customer-paid part runs only the sanity check (`vendorNet > 0`, the COD handling fee
 *      still the vendor's — D-5). That is the one refusal left (`deliveryMinimum.met: false`
 *      ⇒ checkout answers `ORDER_BELOW_DELIVERY_MINIMUM`).
 *
 * `commissionPercent: null` means "could not be resolved" (the quote's lenient mode): steps 3
 * and 4 are skipped, the payer is the terms' verdict alone, and `deliveryMinimum` is null.
 */

export interface PricingLine {
  unitPrice: number;
  quantity: number;
  /** The bargain floor (the AI margin counts in the cap's vendor-net half). */
  floorPrice: number | null;
  /** `null` = no resolvable agency: counted in the subtotal, carried by no shipment. */
  agencyId: string | null;
  pickupSource: 'vendor_address' | 'agency_storage' | null;
  /** The pickup's region (vendor address geo / the depot's), `null` when unknown. */
  pickupRegion: string | null;
  /** Grams for ONE unit (`resolveItemWeightGrams` — the D-4 fallback already applied). */
  unitWeightGrams: number;
}

export interface VendorOrderPricingFacts {
  paymentMethod: 'online' | 'cash_on_delivery';
  /** The drop-off's region; `null` = unknown ⇒ every shipment in-region (never guessed). */
  deliveryRegion: string | null;
  terms: VendorDeliveryTerms;
  commissionPercent: number | null;
  policiesByAgency: Map<string, IAgencyPolicies | null>;
  /** The fee for an agency with no pricing policy. */
  flatFeeFallback: number;
  maxDeliveryPercent?: number;
}

export interface PricedShipment {
  agencyId: string;
  /** Indexes into the input `lines`. */
  lineIndexes: number[];
  mix: PickupMix;
  weightGrams: number;
  outOfRegion: boolean;
  fee: number;
  /** `null` when the agency had no pricing policy (the flat fallback was charged). */
  components: ShipmentFeeComponents | null;
}

export interface VendorOrderPricing {
  itemsSubtotal: number;
  terms: VendorDeliveryTerms;
  payer: DeliveryPayer;
  payerReason: DeliveryPayerReason;
  /**
   * How much more of this shop's items would make delivery free: the `above` threshold's gap,
   * or (cap fallback) what the ADR-A07 cap needs. `null` when n/a — or when no basket size can
   * make it free under the agency's current pricing.
   */
  freeDeliveryShortfall: number | null;
  shipments: PricedShipment[];
  /** Σ shipment fees — what the agencies are paid, whoever pays. */
  deliveryFeeTotal: number;
  /** What the CUSTOMER pays for delivery: Σ fees when customer-paid, else 0. */
  deliveryCharged: number;
  /** What the VENDOR pays for delivery: Σ fees when vendor-paid, else 0. */
  absorbedByVendor: number;
  /** `itemsSubtotal + deliveryCharged` (tax and discount are pinned 0). */
  total: number;
  /** The vendor-paid cap verdict when it ran (it decided `cap_fallback`), else null. */
  capCheck: DeliveryCostUnitsVerdict | null;
  /**
   * The check checkout REFUSES on: the cap when the vendor pays (always met — a failure fell
   * back), the sanity check when the customer pays. `null` = not evaluated (no commission).
   */
  deliveryMinimum: DeliveryCostUnitsVerdict | null;
}

/** Group the lines by agency (first-seen order) and price each group. */
export function priceShipments(lines: PricingLine[], facts: Pick<VendorOrderPricingFacts, 'deliveryRegion' | 'policiesByAgency' | 'flatFeeFallback'>): PricedShipment[] {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (!line.agencyId) return;
    const list = groups.get(line.agencyId) ?? [];
    list.push(index);
    groups.set(line.agencyId, list);
  });

  const out: PricedShipment[] = [];
  for (const [agencyId, lineIndexes] of groups) {
    const groupLines = lineIndexes.map((i) => lines[i]);
    const mix: PickupMix = { hasPickupBased: false, hasStorageBased: false };
    for (const l of groupLines) {
      if (l.pickupSource === 'vendor_address') mix.hasPickupBased = true;
      if (l.pickupSource === 'agency_storage') mix.hasStorageBased = true;
    }
    const weightGrams = shipmentWeightGrams(groupLines.map((l) => ({ grams: l.unitWeightGrams, quantity: l.quantity })));
    // Any line whose pickup is KNOWN to sit in another region makes the run out-of-region;
    // an unknown side never does (`isOutOfRegion`).
    const outOfRegion = groupLines.some((l) => isOutOfRegion(facts.deliveryRegion, l.pickupRegion));
    const policies = facts.policiesByAgency.get(agencyId) ?? null;
    if (policies) {
      const priced = computeShipmentFee(policies, { mix, totalWeightGrams: weightGrams, outOfRegion });
      out.push({ agencyId, lineIndexes, mix, weightGrams, outOfRegion, fee: priced.fee, components: priced.components });
    } else {
      out.push({ agencyId, lineIndexes, mix, weightGrams, outOfRegion, fee: Math.max(0, facts.flatFeeFallback), components: null });
    }
  }
  return out;
}

export function priceVendorOrder(lines: PricingLine[], facts: VendorOrderPricingFacts): VendorOrderPricing {
  const itemsSubtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const shipments = priceShipments(lines, facts);
  const deliveryFeeTotal = shipments.reduce((sum, s) => sum + s.fee, 0);

  const capLine = (l: PricingLine): DeliveryCapLine => ({ unitPrice: l.unitPrice, quantity: l.quantity, floorPrice: l.floorPrice });
  const unitInput = {
    lines: lines.map(capLine),
    groups: shipments.map((s) => ({
      agencyId: s.agencyId,
      fee: s.fee,
      codHandling: facts.policiesByAgency.get(s.agencyId)?.pricing?.additional_fees?.cod_handling_fee ?? null,
      lines: s.lineIndexes.map((i) => capLine(lines[i])),
    })),
    paymentMethod: facts.paymentMethod,
    maxDeliveryPercent: facts.maxDeliveryPercent,
  };

  const verdict = resolveDeliveryPayer(facts.terms, itemsSubtotal);
  let payer: DeliveryPayer = verdict.payer;
  let payerReason: DeliveryPayerReason = verdict.reason;
  let freeDeliveryShortfall = verdict.freeDeliveryShortfall;
  let capCheck: DeliveryCostUnitsVerdict | null = null;
  let deliveryMinimum: DeliveryCostUnitsVerdict | null = null;

  if (facts.commissionPercent !== null) {
    const commissionPercent = facts.commissionPercent;
    if (payer === 'vendor') {
      capCheck = assessDeliveryCostUnits({ ...unitInput, commissionPercent, customerPaysDelivery: false });
      if (!capCheck.met) {
        // D-6: the shop cannot carry its delivery — the customer pays it instead.
        payer = 'customer';
        payerReason = 'cap_fallback';
        const unsatisfiable = capCheck.units.some((u) => !u.met && u.minimumSubtotal === null);
        freeDeliveryShortfall = unsatisfiable ? null : capCheck.shortfall;
      } else {
        deliveryMinimum = capCheck;
      }
    }
    if (payer === 'customer') {
      deliveryMinimum = assessDeliveryCostUnits({ ...unitInput, commissionPercent, customerPaysDelivery: true });
    }
  }

  const deliveryCharged = payer === 'customer' ? deliveryFeeTotal : 0;
  return {
    itemsSubtotal,
    terms: facts.terms,
    payer,
    payerReason,
    freeDeliveryShortfall,
    shipments,
    deliveryFeeTotal,
    deliveryCharged,
    absorbedByVendor: payer === 'vendor' ? deliveryFeeTotal : 0,
    total: itemsSubtotal + deliveryCharged,
    capCheck,
    deliveryMinimum,
  };
}
