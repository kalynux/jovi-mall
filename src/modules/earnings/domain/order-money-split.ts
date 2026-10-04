import { computeNegotiatedLineSplit } from '../services/negotiation-margin.service';
import { EARNINGS_CONFIG } from '../config/earnings.config';

/**
 * Who gets what from one order, and on what basis — the administrator's money-split view
 * (`GET /api/internal/admin/earnings/orders/:orderId/split`, wi-admin
 * `GET /api/v1/money/orders/:orderId/split`). Owner request 2026-10-04: support must be able
 * to explain to a vendor why they received the amount they see, from the moment that amount
 * can be known.
 *
 * PURE: types and arithmetic over already-loaded facts, no Mongoose, no I/O. The I/O half is
 * `services/order-money-split.service.ts`; `test:order-money-split` drives this file.
 *
 * ── One order is split at up to THREE kinds of moment, and the view mirrors them ───────────
 *   payment          prepaid: the items — bargain fee, commission, vendor net (`splitOrder`)
 *   delivery         prepaid: one shipment's fee — agency, agent, refunds (`splitShipmentDelivery`
 *                    or, when the customer paid the rider the fee in cash, the fee-only collection)
 *   cash_collection  COD: one shipment's cash — everything above, at once (`splitCodCollection`)
 *
 * Each moment is a SECTION. A section is `allocated` once its split has run (every figure is
 * then read from `earnings_allocations`, never recomputed) and `projected` before (every figure
 * comes from the split's own `compute*` method, so the preview and the split cannot be two
 * formulas). ⚠ A projection is an ESTIMATE: the commission rate is read again at payment, an
 * agent's cut is unknown until an agent accepts, and an agency may still re-price the run.
 *
 * ── The reconciliation is the check, not decoration ─────────────────────────────────────────
 * `charged` is what the customer paid (online + any delivery cash handed to the rider);
 * `distributed` is Σ every non-reversed line. On a fully split order the two are EQUAL — the
 * splits are built to reconcile exactly (see `EarningsSplitService`). A non-zero difference is
 * a real finding (a shipment created after payment whose fee nobody was charged, a refund
 * half-applied) and is reported rather than hidden.
 */

export type MoneySplitMoment = 'payment' | 'delivery' | 'cash_collection';
export type MoneySplitSourceType = 'order' | 'shipment' | 'cod_collection';

/**
 * `allocated` — the split ran; `projected` — it has not, and this is what it would write;
 * `none` — nothing will be split for this moment (see `noneReason`); `unavailable` — it could
 * not be projected (the reason is logged on the jovi-mall side).
 */
export type MoneySplitSectionState = 'allocated' | 'projected' | 'none' | 'unavailable';

export type MoneySplitNoneReason =
  /** The order was cancelled or refunded before this moment's split. */
  | 'order_void'
  /** A COD shipment that came back collected no cash, so nothing is split (see `isReturnedCod`). */
  | 'returned_without_cash'
  /**
   * An order paid before the delivery fee was deferred banked the agency's whole fee AT
   * PAYMENT (shown in the payment section); `splitShipmentDelivery` skips this run on purpose.
   */
  | 'agency_paid_at_payment';

export type MoneyLineRole =
  /** `platform_ai` — 30% of what each bargainable line sold for above the vendor's minimum. */
  | 'bargain_fee'
  /** `platform` — the vendor's plan rate on the items after the bargain fee. */
  | 'commission'
  /** `vendor` — what is left of the items. */
  | 'vendor_net'
  /** `agency` — the delivery fee the run earned, minus the agent's cut, plus any COD handling fee. */
  | 'delivery_agency'
  /** `agent` — the agent's contracted share of the fee the run earned. */
  | 'delivery_agent'
  /** `vendor` — the unspent part of a vendor-paid fee when a parcel came back. */
  | 'delivery_refund_vendor'
  /** `customer` — owed back to the customer (unspent fee they paid, or paid above the fee). NOT an allocation. */
  | 'delivery_refund_customer';

export type MoneyBeneficiaryType = 'platform' | 'platform_ai' | 'vendor' | 'agency' | 'agent' | 'customer';

/**
 * `projected` — not split yet; `held` / `released` / `reversed` — the allocation's status;
 * `owed` — a customer refund recorded on the shipment (settled through the delivery-fee
 * refund queue, not through an earnings account).
 */
export type MoneyLineStatus = 'projected' | 'held' | 'released' | 'reversed' | 'owed';

/** Why a `held` line has not been released yet. Several may apply at once. */
export type MoneyLineWait =
  /** Escrow starts only when the ORDER completes (customer confirmation or the auto-confirm sweep). */
  | 'order_not_completed'
  /** The order completed; `HOLD_DAYS` have not elapsed (`holdReleaseAt`). */
  | 'hold_window'
  /** COD cash has not physically reached the platform yet (agent → agency → platform). */
  | 'cash_not_settled';

export interface MoneyLine {
  role: MoneyLineRole;
  beneficiary: { type: MoneyBeneficiaryType; id: string | null };
  /** `null` only for an agent's share that cannot be known yet (no agent has accepted the run). */
  amount: number | null;
  status: MoneyLineStatus;
  allocationId: string | null;
  holdReleaseAt: Date | null;
  releasedAt: Date | null;
  requiresCashSettlement: boolean;
  cashSettledAt: Date | null;
  waitingOn: MoneyLineWait[];
}

export interface BargainFeeLineBasis {
  orderItemId: string;
  title: string | null;
  /** What the customer paid per unit. */
  unitPrice: number;
  /** The vendor's minimum as snapshotted at checkout; `null` ⇒ not a bargainable line (no fee). */
  floorPrice: number | null;
  quantity: number;
  /** `(unitPrice − floorPrice) × quantity`. */
  uplift: number;
  /** `floor(percent% × uplift)`. */
  fee: number;
}

/** The numbers behind the items' division. Every field is minor units. */
export interface GoodsBasis {
  /** What the items sold for (the customer-paid delivery fee is never part of it). */
  gross: number;
  bargainFee: {
    percent: number;
    amount: number;
    lines: BargainFeeLineBasis[];
  };
  commission: {
    percent: number;
    /** `gross − bargainFee` — no commission is charged on money already taken as the bargain fee. */
    base: number;
    amount: number;
  };
  /** The part of the delivery fee the VENDOR pays (0 when the customer pays delivery). */
  deliveryFeeCharged: number;
  /** COD only: the agency's handling fee on the goods, paid by the vendor. 0 on prepaid. */
  codHandlingFee: number;
  vendorNet: number;
}

export type DeliveryFeeSource =
  /** A fee the vendor approved for this shipment (`delivery_fee_override`). */
  | 'vendor_approved'
  /** The posted price snapshotted at checkout (or at collection, for COD). */
  | 'snapshot'
  /** Priced live from the agency's policy — no snapshot existed. */
  | 'formula';

export interface AgentSplitBasis {
  model: 'percentage' | 'flat' | 'monthly_salary';
  percent: number | null;
  flatAmount: number | null;
}

/** The numbers behind one shipment's delivery fee. Every amount is minor units. */
export interface DeliveryBasis {
  /** The agency's fee for the run. */
  fee: number;
  feeSource: DeliveryFeeSource;
  payer: 'vendor' | 'customer';
  /** What the customer paid toward it (online or to the rider). */
  customerPaid: number;
  /** What the vendor bears of it (deducted from the vendor's net). */
  vendorBorne: number;
  /** `expected` — not over yet, projected as delivered. */
  outcome: 'delivered' | 'returned' | 'expected';
  /** What the run earns out of `fee` — all of it delivered, the agency's return fee when returned. */
  earnedFee: number;
  /** COD only, kept whole by the agency. */
  codHandlingFee: number;
  /** `null` when no agent has accepted the run yet — the agency line then includes the agent's future share. */
  agentCut: number | null;
  agentSplit: AgentSplitBasis | null;
  refundToVendor: number;
  refundToCustomer: number;
}

export interface MoneySplitSection {
  /** `payment` or `shipment:<id>` — stable, for a client's list key. */
  key: string;
  moment: MoneySplitMoment;
  source: { type: MoneySplitSourceType; id: string | null };
  state: MoneySplitSectionState;
  noneReason: MoneySplitNoneReason | null;
  shipment: {
    id: string;
    trackingNumber: string | null;
    status: string;
    agencyId: string;
    agentId: string | null;
  } | null;
  goods: GoodsBasis | null;
  delivery: DeliveryBasis | null;
  lines: MoneyLine[];
  /**
   * Things a reader must know to read the numbers right:
   *  - `commission_rate_may_change` — projected: the rate is read again when the money moves;
   *  - `agent_not_assigned`         — the agent's share is inside the agency line until someone accepts;
   *  - `vendor_net_negative`        — the split would REFUSE this (EARNINGS_INVALID_SPLIT);
   *  - `fee_not_charged_to_vendor`  — a shipment created after payment: its fee was never deducted;
   *  - `legacy_agency_on_order`     — an order paid before the fee was deferred: the agency was paid at payment.
   */
  notes: MoneySplitNote[];
}

export type MoneySplitNote =
  | 'commission_rate_may_change'
  | 'agent_not_assigned'
  | 'vendor_net_negative'
  | 'fee_not_charged_to_vendor'
  | 'legacy_agency_on_order';

export interface OrderMoneySplitDto {
  order: {
    id: string;
    orderNumber: string;
    vendorId: string;
    customerId: string;
    currency: string;
    orderType: string;
    paymentMethod: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    deliveryPayer: 'vendor' | 'customer';
    completedAt: Date | null;
    createdAt: Date | null;
  };
  /** What the customer paid (or will pay). */
  charged: {
    items: number;
    /** Customer-paid delivery charged with the order (online, or inside the COD cash). */
    delivery: number;
    /** Customer-paid delivery handed to the rider in cash on an online order. */
    deliveryInCash: number;
    total: number;
  };
  sections: MoneySplitSection[];
  totals: {
    platform: { commission: number; bargainFee: number; total: number };
    vendor: number;
    agencies: number;
    agents: number;
    customerRefunds: number;
    /** Σ reversed lines — money taken back by a refund. Excluded from everything above. */
    reversed: number;
  };
  reconciliation: {
    charged: number;
    distributed: number;
    /** `charged − distributed`. 0 on a fully split, unrefunded order. */
    difference: number;
    /** `false` while any section is `none` / `unavailable` or any line is reversed — the difference then means little. */
    complete: boolean;
  };
  /** `true` while any section is projected. */
  estimated: boolean;
  /** Days between the order completing and its money becoming withdrawable. */
  holdDays: number;
  /** The bargain-fee rate in force. */
  bargainFeePercent: number;
}

// ── Pure builders ────────────────────────────────────────────────────────────────────────

/** An allocation row as this view reads it (lean). */
export interface AllocationFacts {
  _id: unknown;
  source_type: string;
  source_id: unknown;
  beneficiary_type: string;
  beneficiary_id: unknown;
  gross_snapshot: number;
  commission_percent_snapshot: number;
  amount: number;
  status: 'held' | 'released' | 'reversed';
  completed_at: Date | null;
  hold_release_at: Date | null;
  released_at: Date | null;
  requires_cash_settlement: boolean;
  cash_settled_at: Date | null;
}

/** The role a row plays, from the moment it was written at and whose it is. */
export function roleOf(sourceType: string, beneficiaryType: string): MoneyLineRole {
  if (beneficiaryType === 'platform_ai') return 'bargain_fee';
  if (beneficiaryType === 'platform') return 'commission';
  if (beneficiaryType === 'agency') return 'delivery_agency';
  if (beneficiaryType === 'agent') return 'delivery_agent';
  // A vendor row on a delivery source is the unspent fee coming back; on the order or a COD
  // collection it is the vendor's share of the goods.
  return sourceType === 'shipment' ? 'delivery_refund_vendor' : 'vendor_net';
}

/** Why a held row is not released yet — every reason that applies, in the order they clear. */
export function waitingOnOf(row: AllocationFacts, now: Date): MoneyLineWait[] {
  if (row.status !== 'held') return [];
  const waits: MoneyLineWait[] = [];
  if (!row.completed_at) waits.push('order_not_completed');
  else if (!row.hold_release_at || row.hold_release_at.getTime() > now.getTime()) waits.push('hold_window');
  if (row.requires_cash_settlement && !row.cash_settled_at) waits.push('cash_not_settled');
  return waits;
}

export function lineFromAllocation(row: AllocationFacts, now: Date): MoneyLine {
  return {
    role: roleOf(row.source_type, row.beneficiary_type),
    beneficiary: {
      type: row.beneficiary_type as MoneyBeneficiaryType,
      id: row.beneficiary_id ? String(row.beneficiary_id) : null,
    },
    amount: row.amount,
    status: row.status,
    allocationId: String(row._id),
    holdReleaseAt: row.hold_release_at ?? null,
    releasedAt: row.released_at ?? null,
    requiresCashSettlement: row.requires_cash_settlement === true,
    cashSettledAt: row.cash_settled_at ?? null,
    waitingOn: waitingOnOf(row, now),
  };
}

/** A line that has not been written yet. Zero amounts are dropped, exactly as `persist` skips them. */
export function projectedLine(
  role: MoneyLineRole,
  beneficiary: { type: MoneyBeneficiaryType; id: string | null },
  amount: number | null,
  requiresCashSettlement = false
): MoneyLine | null {
  if (amount !== null && amount <= 0) return null;
  return {
    role,
    beneficiary,
    amount,
    status: 'projected',
    allocationId: null,
    holdReleaseAt: null,
    releasedAt: null,
    requiresCashSettlement,
    cashSettledAt: null,
    waitingOn: [],
  };
}

/** A customer refund recorded on a shipment. Not an allocation; `owed` until the refund queue settles it. */
export function customerRefundLine(customerId: string, amount: number, projected: boolean): MoneyLine | null {
  if (!(amount > 0)) return null;
  return {
    role: 'delivery_refund_customer',
    beneficiary: { type: 'customer', id: customerId },
    amount,
    status: projected ? 'projected' : 'owed',
    allocationId: null,
    holdReleaseAt: null,
    releasedAt: null,
    requiresCashSettlement: false,
    cashSettledAt: null,
    waitingOn: [],
  };
}

/** One item line as the bargain-fee arithmetic sees it — `quantity` is the moment's own. */
export interface BargainLineFacts {
  orderItemId: string;
  title: string | null;
  unitPrice: number;
  floorPrice: number | null;
  quantity: number;
}

/**
 * The per-line basis of a bargain fee, through the SAME function the split sums
 * (`computeNegotiatedLineSplit`) — so Σ `fee` here is the split's `aiMargin` by construction.
 * Lines with no floor are kept (fee 0) so a reader sees every item, not only the ones charged.
 */
export function bargainFeeLinesOf(lines: BargainLineFacts[]): BargainFeeLineBasis[] {
  return lines.map((line) => {
    const split = computeNegotiatedLineSplit({
      unitPrice: line.unitPrice,
      floorPrice: line.floorPrice,
      quantity: line.quantity,
    });
    return {
      orderItemId: line.orderItemId,
      title: line.title,
      unitPrice: line.unitPrice,
      floorPrice: line.floorPrice,
      quantity: line.quantity,
      uplift: split.uplift,
      fee: split.aiMargin,
    };
  });
}

/** The goods basis from its parts. `base` is always `gross − bargainFee`. */
export function goodsBasisOf(input: {
  gross: number;
  bargainFee: number;
  bargainLines: BargainFeeLineBasis[];
  commissionPercent: number;
  commission: number;
  deliveryFeeCharged: number;
  codHandlingFee: number;
  vendorNet: number;
}): GoodsBasis {
  return {
    gross: input.gross,
    bargainFee: {
      percent: EARNINGS_CONFIG.AI_MARGIN_PERCENT,
      amount: input.bargainFee,
      lines: input.bargainLines,
    },
    commission: {
      percent: input.commissionPercent,
      base: input.gross - input.bargainFee,
      amount: input.commission,
    },
    deliveryFeeCharged: input.deliveryFeeCharged,
    codHandlingFee: input.codHandlingFee,
    vendorNet: input.vendorNet,
  };
}

/**
 * The goods basis of an ALLOCATED prepaid payment split, read back from its rows.
 *
 * `deliveryFeeCharged` is the residual `gross − bargainFee − commission − vendorNet` — exact,
 * because `splitOrder` writes `vendorNet = gross − aiMargin − commission − vendorBorneDelivery`
 * (the same identity NET_FORMULA states). A delivery-fee re-price after payment adjusts the
 * vendor's row in place, and the residual follows it.
 */
export function prepaidGoodsFromRows(rows: AllocationFacts[], bargainLines: BargainFeeLineBasis[]): GoodsBasis | null {
  const vendor = rows.find((r) => r.beneficiary_type === 'vendor');
  const platform = rows.find((r) => r.beneficiary_type === 'platform');
  const ai = rows.find((r) => r.beneficiary_type === 'platform_ai');
  const anchor = vendor ?? platform ?? ai;
  if (!anchor) return null;
  const gross = anchor.gross_snapshot;
  const bargainFee = ai?.amount ?? 0;
  const commission = platform?.amount ?? 0;
  const vendorNet = vendor?.amount ?? 0;
  return goodsBasisOf({
    gross,
    bargainFee,
    bargainLines,
    commissionPercent: anchor.commission_percent_snapshot,
    commission,
    deliveryFeeCharged: gross - bargainFee - commission - vendorNet,
    codHandlingFee: 0,
    vendorNet,
  });
}

/** Where a shipment's fee came from — the precedence `computeShipmentDeliveryFee` applies. */
export function feeSourceOf(shipment: {
  delivery_fee_override?: { amount?: number | null } | null;
  delivery_fee_snapshot?: number | null;
}): DeliveryFeeSource {
  const override = shipment.delivery_fee_override?.amount;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return 'vendor_approved';
  const snapshot = shipment.delivery_fee_snapshot;
  if (typeof snapshot === 'number' && Number.isFinite(snapshot) && snapshot >= 0) return 'snapshot';
  return 'formula';
}

export function agentSplitBasisOf(
  split: { model?: string | null; agent_share_percent?: number | null; agent_flat_fee?: number | null } | null | undefined
): AgentSplitBasis | null {
  if (!split) return null;
  const model = split.model === 'flat' || split.model === 'monthly_salary' ? split.model : 'percentage';
  return {
    model,
    percent: model === 'percentage' ? split.agent_share_percent ?? null : null,
    flatAmount: model === 'flat' ? split.agent_flat_fee ?? null : null,
  };
}

/** Totals and the reconciliation over a finished set of sections. */
export function summarise(
  sections: MoneySplitSection[],
  charged: number
): { totals: OrderMoneySplitDto['totals']; reconciliation: OrderMoneySplitDto['reconciliation']; estimated: boolean } {
  const totals: OrderMoneySplitDto['totals'] = {
    platform: { commission: 0, bargainFee: 0, total: 0 },
    vendor: 0,
    agencies: 0,
    agents: 0,
    customerRefunds: 0,
    reversed: 0,
  };
  let anyReversed = false;

  for (const section of sections) {
    for (const line of section.lines) {
      const amount = line.amount ?? 0;
      if (line.status === 'reversed') {
        anyReversed = true;
        totals.reversed += amount;
        continue;
      }
      switch (line.role) {
        case 'bargain_fee':
          totals.platform.bargainFee += amount;
          break;
        case 'commission':
          totals.platform.commission += amount;
          break;
        case 'vendor_net':
        case 'delivery_refund_vendor':
          totals.vendor += amount;
          break;
        case 'delivery_agency':
          totals.agencies += amount;
          break;
        case 'delivery_agent':
          totals.agents += amount;
          break;
        case 'delivery_refund_customer':
          totals.customerRefunds += amount;
          break;
      }
    }
  }
  totals.platform.total = totals.platform.commission + totals.platform.bargainFee;

  const distributed =
    totals.platform.total + totals.vendor + totals.agencies + totals.agents + totals.customerRefunds;
  const complete =
    !anyReversed && sections.every((s) => s.state === 'allocated' || s.state === 'projected');

  return {
    totals,
    reconciliation: { charged, distributed, difference: charged - distributed, complete },
    estimated: sections.some((s) => s.state === 'projected'),
  };
}
