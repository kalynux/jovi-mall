import { EARNINGS_CONFIG } from '../config/earnings.config';
import { ICodHandlingFee } from '../../delivery/delivery-agency.model';
import { computeCodHandlingFee } from './earnings-quote.service';
import { computeNegotiatedLineSplit } from './negotiation-margin.service';

/**
 * The delivery-cost cap — the pure half (ADR-A07).
 *
 * ⚠ AMENDED by ADR-A11 (customer-paid delivery, 2026-10-03): the cap now runs ONLY for a shop
 * part whose delivery the VENDOR pays (shop terms `always`, or `above` with the threshold met).
 * When it fails, checkout no longer refuses — the shop part falls back to customer-paid
 * (`delivery_payer_reason: 'cap_fallback'`). A customer-paid part is checked with
 * `enforceRatio: false` (only `vendorNet > 0`, the COD handling fee still on the vendor).
 * The history below describes the vendor-paid world the rule was written for.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * The customer pays for the goods only; the agency's delivery fee (and, on COD, its handling
 * fee) comes out of the VENDOR's share: `vendorNet = gross − aiMargin − commission − fee`.
 * Nothing at checkout compared the two, so a 500 basket with a 1 000 delivery fee was accepted,
 * paid (or its cash collected at the door) — and only then did `splitOrder` /
 * `splitCodCollection` throw `EARNINGS_INVALID_SPLIT`, leaving money that had already moved
 * with no allocation behind it.
 *
 * ── The rule (owner decision 2026-09-27) ─────────────────────────────────────
 *
 *     deliveryCost = deliveryFee + codHandlingFee
 *     (1)  deliveryCost × 100 ≤ R × subtotal         R = MAX_DELIVERY_COST_PERCENT (30)
 *     (2)  vendorNet > 0                             the full backstop
 *
 * ⚠ **Commission is deliberately NOT in (1).** It is a plan term an administrator sets, and
 * putting it inside the same 30% would make every sale impossible on a plan at or above 30%
 * and would move every vendor's minimum basket each time a commission is edited. (2) is where
 * commission and the AI margin are counted, so the vendor still never lands on zero.
 *
 * ⚠ **(1) is measured on the SUBTOTAL — what the customer pays for these lines** — not on
 * `vendorGross`. That keeps it computable before checkout, where a negotiated line's floor is a
 * secret the cart never carries (`cart.service.ts`), and it is the owner's own wording.
 *
 * ⚠ **The unit is the caller's, and must be the SPLIT's unit** — the whole vendor order for an
 * online payment (`splitOrder` sums every shipment's fee against the order), ONE shipment for
 * cash on delivery (`splitCodCollection` splits each collection on its own slice). See
 * `DeliveryCostCapService`.
 *
 * Pure and DB-free, like `negotiation-margin.service.ts`, so `test:delivery-cost-cap` runs the
 * real arithmetic with no connection. The COD fee reuses `computeCodHandlingFee`, the function
 * the split charges with — one definition, so the check and the charge cannot disagree.
 */

/** Which half of the rule refused. */
export type DeliveryCostCapFailure = 'delivery_cost_ratio' | 'vendor_net_not_positive';

export interface DeliveryCostCapInput {
  /** What the customer pays for the lines in this unit, minor units. */
  subtotal: number;
  /** The platform's share of the bargaining uplift on these lines. 0 when none, or unknown. */
  aiMargin?: number;
  /** The vendor's plan commission, as the split reads it (`getEntitlements`). */
  commissionPercent: number;
  /** The agency delivery fee(s) this unit is charged. */
  deliveryFee: number;
  /** The agency's COD handling fee config — pass it ONLY for a cash-on-delivery unit. */
  codHandling?: ICodHandlingFee | null;
  /** Defaults to `EARNINGS_CONFIG.MAX_DELIVERY_COST_PERCENT`. */
  maxDeliveryPercent?: number;
  /**
   * `false` evaluates ONLY half (2), `vendorNet > 0` — the customer-paid sanity check (ADR-A11):
   * when the customer pays the delivery fee the 30% ratio has nothing to bound (the vendor
   * carries no delivery fee, only the COD handling fee on cash). Default `true`.
   */
  enforceRatio?: boolean;
}

export interface DeliveryCostCapVerdict {
  met: boolean;
  failure: DeliveryCostCapFailure | null;
  subtotal: number;
  /** `deliveryFee + codFee`. */
  deliveryCost: number;
  codFee: number;
  commission: number;
  /** `subtotal − aiMargin − commission − deliveryCost`, exactly as the split computes it. */
  vendorNet: number;
  maxDeliveryPercent: number;
  /**
   * The smallest subtotal this unit would pass at, all else equal. `null` when no subtotal
   * can pass (a COD percentage at or above the cap, or commission + COD percentage ≥ 100).
   *
   * ⚠ Computed with NO AI margin: a negotiated line's floor is secret, and the quote cannot
   * know it. The authoritative `met` at checkout does count it.
   */
  minimumSubtotal: number | null;
  /** `max(0, minimumSubtotal − subtotal)`; 0 when met or unsatisfiable. */
  shortfall: number;
}

/** The cap, clamped to [1, 100]. */
export function resolveMaxDeliveryPercent(raw?: number): number {
  const value = raw ?? EARNINGS_CONFIG.MAX_DELIVERY_COST_PERCENT;
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

interface Terms {
  aiMargin: number;
  commissionPercent: number;
  deliveryFee: number;
  codHandling: ICodHandlingFee | null;
  maxDeliveryPercent: number;
  enforceRatio: boolean;
}

function check(subtotal: number, terms: Terms) {
  const codFee = computeCodHandlingFee(terms.codHandling, subtotal);
  const deliveryCost = terms.deliveryFee + codFee;
  const vendorGross = subtotal - terms.aiMargin;
  // Same rounding as the split: the commission is floored on vendorGross.
  const commission = Math.floor((vendorGross * terms.commissionPercent) / 100);
  const vendorNet = vendorGross - commission - deliveryCost;

  let failure: DeliveryCostCapFailure | null = null;
  if (terms.enforceRatio && deliveryCost * 100 > terms.maxDeliveryPercent * subtotal) failure = 'delivery_cost_ratio';
  else if (vendorNet <= 0) failure = 'vendor_net_not_positive';

  return { codFee, deliveryCost, commission, vendorNet, failure };
}

/** How far the scan around the closed-form estimate may walk. Rounding moves it by a few francs. */
const SCAN_LIMIT = 1_000;

/**
 * The smallest subtotal that passes, or `null` when none can.
 *
 * Closed form first — (1) gives `g ≥ (F + k)·100 / (R − p)` and (2) gives
 * `g > (F + k)·100 / (100 − c − p)`, with `F` the fee, `k` a fixed COD fee and `p` a percentage
 * one — then a short walk to absorb the floors, so the answer is the value `check` itself
 * accepts rather than one the algebra predicts.
 */
export function minimumSubtotalFor(
  terms: Omit<Terms, 'aiMargin' | 'enforceRatio'> & { enforceRatio?: boolean },
): number | null {
  const t: Terms = { ...terms, aiMargin: 0, enforceRatio: terms.enforceRatio ?? true };
  const fixed = t.deliveryFee + (t.codHandling?.type === 'fixed' ? t.codHandling.value : 0);
  const pct = t.codHandling?.type === 'percentage' ? t.codHandling.value : 0;

  const ratioSpan = t.maxDeliveryPercent - pct;
  const netSpan = 100 - t.commissionPercent - pct;

  let ratioMin: number;
  if (!t.enforceRatio || (fixed === 0 && pct === 0)) ratioMin = 1;
  else if (ratioSpan <= 0) return null;
  else ratioMin = Math.ceil((fixed * 100) / ratioSpan);

  if (netSpan <= 0) return null;
  const netMin = Math.floor((fixed * 100) / netSpan) + 1;

  let g = Math.max(1, ratioMin, netMin);
  const passes = (value: number) => check(value, t).failure === null;

  // Walk up to the first passing value…
  let steps = 0;
  while (!passes(g)) {
    if (++steps > SCAN_LIMIT) return null;
    g++;
  }
  // …then down, in case a floor let a smaller value through.
  steps = 0;
  while (g > 1 && passes(g - 1) && steps++ < SCAN_LIMIT) g--;

  return g;
}

/** Evaluate one unit — a vendor order (online) or one shipment (COD). */
export function evaluateDeliveryCostCap(input: DeliveryCostCapInput): DeliveryCostCapVerdict {
  const terms: Terms = {
    aiMargin: Math.max(0, input.aiMargin ?? 0),
    commissionPercent: Math.max(0, Math.min(100, input.commissionPercent)),
    deliveryFee: Math.max(0, input.deliveryFee),
    codHandling: input.codHandling ?? null,
    maxDeliveryPercent: resolveMaxDeliveryPercent(input.maxDeliveryPercent),
    enforceRatio: input.enforceRatio ?? true,
  };

  const result = check(input.subtotal, terms);
  const minimumSubtotal = minimumSubtotalFor(terms);
  const met = result.failure === null;

  return {
    met,
    failure: result.failure,
    subtotal: input.subtotal,
    deliveryCost: result.deliveryCost,
    codFee: result.codFee,
    commission: result.commission,
    vendorNet: result.vendorNet,
    maxDeliveryPercent: terms.maxDeliveryPercent,
    minimumSubtotal,
    shortfall: met || minimumSubtotal === null ? 0 : Math.max(0, minimumSubtotal - input.subtotal),
  };
}

// ─── Units: the split's unit, over a whole vendor order (pure) ───────────────

/** One priced line. `floorPrice` on every line of a bargainable variant (the bargain fee is owed haggled or not). */
export interface DeliveryCapLine {
  unitPrice: number;
  quantity: number;
  floorPrice?: number | null;
}

/** One shipment-to-be (= one agency at checkout) with its fee already priced. */
export interface DeliveryCostUnitGroup {
  agencyId: string;
  /** The shipment's delivery fee — `computeShipmentFee` (weight, region, ceiling) or the flat fallback. */
  fee: number;
  /** The agency's COD handling fee config; read only for a cash-on-delivery unit. */
  codHandling: ICodHandlingFee | null;
  lines: DeliveryCapLine[];
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

export interface DeliveryCostUnitsVerdict {
  scope: 'order' | 'shipment';
  maxDeliveryPercent: number;
  met: boolean;
  /** Online: the order's shortfall. COD: the sum over failing shipments (each needs its own). */
  shortfall: number;
  units: DeliveryCapUnitVerdict[];
}

export const capLinesSubtotal = (lines: DeliveryCapLine[]): number =>
  lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

export const capLinesAiMargin = (lines: DeliveryCapLine[]): number =>
  lines.reduce(
    (sum, l) => sum + computeNegotiatedLineSplit({ unitPrice: l.unitPrice, floorPrice: l.floorPrice, quantity: l.quantity }).aiMargin,
    0,
  );

/**
 * Evaluate a vendor order over the SPLIT's units — online = the whole order, COD = one per
 * shipment — with every fee already priced. THE one place the units are formed; checkout, the
 * cart quote and `DeliveryCostCapService` all reach it.
 *
 * `customerPaysDelivery: true` is the ADR-A11 sanity check: the vendor bears no delivery fee
 * (each unit's fee counts as 0 against the vendor) and only `vendorNet > 0` is enforced — the
 * COD handling fee stays on the vendor (D-5) and is computed on the items subtotal.
 */
export function assessDeliveryCostUnits(input: {
  lines: DeliveryCapLine[];
  groups: DeliveryCostUnitGroup[];
  commissionPercent: number;
  paymentMethod: 'online' | 'cash_on_delivery';
  customerPaysDelivery?: boolean;
  maxDeliveryPercent?: number;
}): DeliveryCostUnitsVerdict {
  const maxDeliveryPercent = resolveMaxDeliveryPercent(input.maxDeliveryPercent);
  const customerPays = input.customerPaysDelivery === true;
  const vendorFee = (fee: number) => (customerPays ? 0 : fee);

  let units: DeliveryCapUnitVerdict[];
  let scope: DeliveryCostUnitsVerdict['scope'];
  if (input.paymentMethod === 'cash_on_delivery') {
    scope = 'shipment';
    units = input.groups.map((group) =>
      toUnitVerdict(
        group.agencyId,
        evaluateDeliveryCostCap({
          subtotal: capLinesSubtotal(group.lines),
          aiMargin: capLinesAiMargin(group.lines),
          commissionPercent: input.commissionPercent,
          deliveryFee: vendorFee(group.fee),
          codHandling: group.codHandling ?? null,
          maxDeliveryPercent,
          enforceRatio: !customerPays,
        }),
      ),
    );
  } else {
    scope = 'order';
    units = [
      toUnitVerdict(
        null,
        evaluateDeliveryCostCap({
          subtotal: capLinesSubtotal(input.lines),
          aiMargin: capLinesAiMargin(input.lines),
          commissionPercent: input.commissionPercent,
          deliveryFee: input.groups.reduce((sum, g) => sum + vendorFee(g.fee), 0),
          codHandling: null,
          maxDeliveryPercent,
          enforceRatio: !customerPays,
        }),
      ),
    ];
  }

  return {
    scope,
    maxDeliveryPercent,
    met: units.every((u) => u.met),
    shortfall: units.reduce((sum, u) => sum + u.shortfall, 0),
    units,
  };
}

function toUnitVerdict(agencyId: string | null, v: DeliveryCostCapVerdict): DeliveryCapUnitVerdict {
  return {
    agencyId,
    subtotal: v.subtotal,
    met: v.met,
    reason: v.failure,
    minimumSubtotal: v.minimumSubtotal,
    shortfall: v.shortfall,
  };
}
