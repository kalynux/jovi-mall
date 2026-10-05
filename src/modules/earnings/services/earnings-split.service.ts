import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import {
  EarningsAllocationRepository,
  CreateAllocationInput,
} from '../repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
// Safe to import directly: earnings-completion imports nothing from this file.
import { earningsCompletionService } from './earnings-completion.service';
import { EARNINGS_CONFIG, daysFromNow } from '../config/earnings.config';
import { EarningsSourceType } from '../models/earnings-allocation.model';
import { IOrder, IOrderItem } from '../../orders/order.model';
import { IBooking } from '../../booking/models/booking.model';
import { IShipment } from '../../shipments/shipment.model';
import { ShipmentRepository } from '../../shipments/shipment.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../agents/repositories/agent-contract.repository';
import { collectionKindOf, ICashCollection } from '../../cod/models/cash-collection.model';
import {
  EarningsQuoteService,
  earningsQuoteService,
  computeAgencyCut,
  computeCodHandlingFee,
  resolveEarnedFee,
  ShipmentDeliveryOutcome,
} from './earnings-quote.service';
// Pure, DB-free, and separate for the same reason EarningsQuoteService is: the
// arithmetic has to be testable without a Mongo connection. See its header for
// why `vendorGross` is `P×qty − aiMargin` and never `floor×qty + 0.7·U`.
import { computeOrderAiMargin, NegotiatedLineInput } from './negotiation-margin.service';
import { deliveredAtOf } from '../domain/earnings-hold';
// Who pays delivery, and how much (ADR-A11) — the pure readers every money path shares.
import {
  collectionBreakdownOf,
  customerDeliveryFeeOf,
  deliveryFeeShares,
  orderItemsGrossOf,
  paysDeliveryFeeInCash,
  rtoLeftoverShares,
} from '../../orders/domain/delivery-payer';

// The pure fee arithmetic lives in `EarningsQuoteService` — see its header. Both
// halves of every division are defined there (`applyFeeSplit` for the agent,
// `computeAgencyCut` for the agency, `computeCodHandlingFee`, `resolveEarnedFee`),
// so what an agent or agency is QUOTED and what this service ALLOCATES cannot
// drift. Re-exported here because this is where callers historically found them.
export { resolveEarnedFee };
export type { ShipmentDeliveryOutcome };

/**
 * One order item, as the bargain-fee arithmetic sees it.
 *
 * ⚠ **The fee is owed on EVERY bargainable line, haggled or not** (owner decision
 * 2026-09-28, reversing D-5's "only on orders carrying a negotiation lock"). A
 * bargainable variant is sold at its ask unless the customer haggles, and the
 * platform takes 30% of whatever the line sold for above the vendor's minimum:
 * a sale at the ask pays it on the whole window, a sale at the minimum pays
 * nothing, and a haggled sale pays it on what the haggling left.
 *
 * So the floor is `floor_price_snapshot` as checkout wrote it — the lock
 * verdict's floor on a negotiated line, the vendor's minimum at checkout on any
 * other bargainable line — with no lock gate in front of it. A `null` floor
 * means the variant was not bargainable, which makes the line arithmetically
 * ordinary: zero uplift, zero fee, and the vendor keeps the whole line. Orders
 * placed before that date carry no floor on un-haggled lines and so pay nothing,
 * which is what they were quoted.
 */
export function bargainLineOf(item: IOrderItem): NegotiatedLineInput {
  return {
    unitPrice: item.price,
    floorPrice: item.floor_price_snapshot ?? null,
    quantity: item.quantity,
  };
}

/**
 * What `splitOrder` divides a prepaid order's ITEMS into — computed by `computeOrderSplit`
 * with no write, so the administrator's money-split view can show it BEFORE payment from
 * the same arithmetic that will run AT payment (see `OrderMoneySplitService`).
 */
export interface OrderSplitComputation {
  /** The items gross (ADR-A11: never a customer-paid delivery fee). */
  gross: number;
  /** The bargain fee — the `platform_ai` share. */
  aiMargin: number;
  commissionPercent: number;
  commission: number;
  /** Σ per shipment of the fee part the customer did NOT pay — deducted from the vendor. */
  vendorBorneDelivery: number;
  /** May be negative here; `splitOrder` refuses that with `EARNINGS_INVALID_SPLIT`. */
  vendorNet: number;
  byShipment: Map<string, number>;
  customerExcessByShipment: Map<string, number>;
}

/** The facts one COD collection split is computed from. `agentId` null ⇒ nobody bound yet. */
export interface CodCollectionSplitInput {
  shipment: IShipment;
  policies: IAgencyPolicies | null;
  agentId: string | null;
  agencyId: string;
  /** The goods the cash pays for. */
  itemsAmount: number;
  /** The customer-paid delivery fee inside the same cash. */
  deliveryFeeAmount: number;
}

/** What `splitCodCollection` divides one collection into. `vendorNet` may be negative here. */
export interface CodCollectionSplitComputation {
  gross: number;
  aiMargin: number;
  commissionPercent: number;
  commission: number;
  deliveryFee: number;
  vendorBorneDelivery: number;
  customerExcess: number;
  codFee: number;
  /** 0 when no agent is bound — exactly what the split would pay; the caller annotates. */
  agentCut: number;
  /** `deliveryFee − agentCut + codFee`. */
  agencyCut: number;
  vendorNet: number;
}

/** What `splitShipmentDelivery` divides one prepaid run into (the ordinary, non-cash branch). */
export interface ShipmentDeliverySplitComputation {
  /** The fee the payer was charged for this run — snapshot first, else live. */
  reservedFee: number;
  /** `true` when `reservedFee` came from no snapshot (a late shipment the vendor was never charged for). */
  reservedFeeComputedLive: boolean;
  earnedFee: number;
  agentId: string | null;
  /** 0 when no agent is bound. */
  agentCut: number;
  agencyCut: number;
  /** The unspent `reserved − earned` the vendor gets back. */
  vendorRefund: number;
  /** What the customer is owed back (unspent fee they covered + anything paid above the fee). */
  customerRefundable: number;
}

/**
 * EarningsSplitService - splits a paid order/booking into per-beneficiary
 * allocations and holds each share in escrow.
 *
 * ── One order's gross is divided across TWO moments ──────────────────────────
 *
 * At PAYMENT (`splitOrder`) the platform's commission and the vendor's net are
 * allocated. The vendor's net is already reduced by the delivery fee, but that
 * fee is NOT allocated to anyone yet: at payment success an order's shipments
 * exist but sit at `pending` with `agent_id: null`, so the agent who will earn a
 * share of it is not yet known — nobody has been dispatched.
 *
 * At DELIVERY (`splitShipmentDelivery`) the fee reserved for each shipment is
 * divided between the agency and that agent, mirroring what COD has always done
 * in `splitCodCollection`. COD orders skip the payment split entirely (there is
 * no payment to split until the cash is handed over) and go through
 * `splitCodCollection` alone.
 *
 * Deferring the fee is what makes an agent paid on an ONLINE-paid delivery, not
 * only a cash one. It changes only WHEN the agency's share is allocated, never
 * the vendor's or the platform's economics.
 *
 * Both splits are idempotent: re-firing a payment webhook or re-running a
 * delivery transition never double-splits (a unique index on
 * (source, beneficiary) plus an up-front `existsForSource` check).
 *
 * ── Escrow is resolved per ORDER, for every actor at once ────────────────────
 *
 * Allocations from both moments are created `held` with no maturity date.
 * `OrderCompletionService` → `EarningsCompletionService.onOrderCompleted` stamps
 * `completed_at` + `hold_release_at` on all of them together when the ORDER
 * completes, and the release worker frees them HOLD_DAYS later. So an agent's cut
 * of a prepaid delivery waits exactly as long as the vendor's, the platform's and
 * a COD agent's — and any new source type MUST be swept there or its money is
 * held forever.
 *
 * The agency's delivery fee is computed from that agency's own `policies.pricing`
 * (pickup-based and/or storage-based flat components), derived from the order's
 * real Shipment documents — not a flat per-agency constant. See
 * `computeShipmentDeliveryFee` below for the exact MINIMAL formula and every
 * deferred pricing component (kept as TODOs).
 *
 * All amounts are integers in minor currency units.
 */
export class EarningsSplitService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly entitlements: EntitlementService = entitlementService,
    private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository(),
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly contracts: AgentContractRepository = agentContractRepository,
    /** Owns the delivery-fee + agent-cut formulas; see EarningsQuoteService. */
    private readonly quotes: EarningsQuoteService = earningsQuoteService
  ) {}

  /**
   * Split a paid order at PAYMENT time: platform commission + vendor net.
   *
   * The delivery fee is computed here — the vendor's net is reduced by it, so the
   * vendor immediately sees the true post-fee figure — but it is deliberately NOT
   * allocated to anyone yet. At payment success the order's shipments exist and
   * sit at `pending` with `agent_id: null`: no agent has been dispatched, and the
   * agent's cut comes out of that same fee. The fee is instead snapshotted onto
   * each shipment and divided by `splitShipmentDelivery` when the delivery
   * actually happens and the agent is known.
   *
   * The gross therefore reconciles across two moments, not one:
   *   gross = aiMargin + commission + vendorNet
   *              + Σ(agency + agent + vendor-refund per shipment)
   *
   * ⚠ `aiMargin` is the newest term (BARGAINING-AGENT-PLAN D-5) and it comes off
   * FIRST, before commission and delivery. It is the platform's 30% of what a
   * bargainable line sold for above the vendor's minimum, haggled or not (the
   * bargain fee — see `bargainLineOf`) — zero on every order with no
   * bargainable line, which is why the reconciliation above still describes one.
   * Commission is then a percentage of `vendorGross` (gross minus the AI margin)
   * rather than of the gross: the platform does not take commission on money it
   * has already taken as margin.
   *
   * Digital orders have no shipments, so there is no delivery fee and nothing is
   * deferred. COD orders never reach this method at all — they have no payment to
   * split until the cash is collected (see `splitCodCollection`).
   */
  async splitOrder(order: IOrder): Promise<void> {
    const sourceId = order._id.toString();
    if (await this.allocationRepo.existsForSource('order', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    const currency = order.currency;
    const {
      gross,
      aiMargin,
      commissionPercent,
      commission,
      vendorBorneDelivery: deliveryTotal,
      vendorNet,
      byShipment,
      customerExcessByShipment,
    } = await this.computeOrderSplit(order);

    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        aiMargin,
        commission,
        deliveryTotal,
      });
    }

    // Record what each shipment was charged BEFORE allocating anything. The
    // delivery-time split divides exactly these numbers rather than recomputing
    // from an agency policy that may have changed in the meantime — see
    // IShipment.delivery_fee_snapshot.
    await this.shipmentRepo.setDeliveryFeeSnapshots(byShipment);
    // Anything the customer paid above the fee finally charged is theirs (only after a fee
    // decrease — W-E). Recorded, never allocated; the refund is W-E's.
    await this.shipmentRepo.setCustomerFeeRefundable(customerExcessByShipment);

    const allocations: CreateAllocationInput[] = [
      {
        source_type: 'order',
        source_id: sourceId,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: vendorNet,
        currency,
      },
      {
        source_type: 'order',
        source_id: sourceId,
        beneficiary_type: 'platform',
        beneficiary_id: null,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: commission,
        currency,
      },
      // The bargaining agent's share. A singleton account like `platform`, kept
      // separate from it so "what did the AI earn us" stays an answerable
      // question. `persist` skips a zero-value row, so an ordinary order writes
      // nothing here.
      {
        source_type: 'order',
        source_id: sourceId,
        beneficiary_type: 'platform_ai',
        beneficiary_id: null,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: aiMargin,
        currency,
      },
    ];

    await this.persist(allocations);

    await this.emitSplit('order', sourceId, vendorId, {
      gross,
      aiMargin,
      commission,
      // Charged to the vendor now, allocated to the agency/agent at delivery.
      deliveryDeferred: deliveryTotal,
      vendorNet,
    });
  }

  /**
   * The arithmetic of `splitOrder`, with no write — the single definition both the split and
   * the administrator's money-split view run, so what an administrator is SHOWN before
   * payment and what is ALLOCATED at payment cannot be two formulas.
   *
   * Reads only (entitlements, shipments, agency policies). The commission rate is the one in
   * force NOW; `splitOrder` reads it again at payment, which is why a pre-payment projection
   * is labelled an estimate.
   */
  async computeOrderSplit(order: IOrder): Promise<OrderSplitComputation> {
    const vendorId = order.vendor_id.toString();
    // ADR-A11: the vendor is measured on the ITEMS. `total_amount` also carries a customer-paid
    // delivery fee, which belongs to the agency side (allocated at delivery) and is never
    // commissioned (D-3). `gross_snapshot` is therefore the items gross on every row, which is
    // what keeps NET_FORMULA's residual exact (`vendors/analytics/net-revenue.ts`).
    const gross = orderItemsGrossOf(order);

    // The bargain fee, summed over the lines that carry one. An order may mix
    // bargainable and ordinary lines, and the total is the sum of the PER-LINE
    // fees — never a fee on the summed uplift, which would round differently and
    // leave the reconciliation a franc short.
    const aiMargin = computeOrderAiMargin(order.items.map(bargainLineOf));
    const vendorGross = gross - aiMargin;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((vendorGross * commissionPercent) / 100);

    // Per-shipment, policy-driven agency delivery fee (physical orders only —
    // digital orders have no shipments). See computeAgencyDeliveryFees for the
    // exact MINIMAL formula and every deferred pricing component.
    const { byShipment, vendorBorneTotal, customerExcessByShipment } =
      order.order_type === 'physical'
        ? await this.computeAgencyDeliveryFees(order)
        : { byShipment: new Map<string, number>(), vendorBorneTotal: 0, customerExcessByShipment: new Map<string, number>() };

    // Only the VENDOR-BORNE part of the fees reduces the vendor's net: all of it on a vendor-paid
    // order, nothing on a customer-paid one (the customer paid it inside `total_amount`).
    return {
      gross,
      aiMargin,
      commissionPercent,
      commission,
      vendorBorneDelivery: vendorBorneTotal,
      vendorNet: vendorGross - commission - vendorBorneTotal,
      byShipment,
      customerExcessByShipment,
    };
  }

  /**
   * The delivery fee a physical order owes, per the MINIMAL formula (see module
   * docs) — both per shipment and totalled per distinct agency.
   *
   * Fee is computed PER SHIPMENT (the real unit of "one agency's one delivery
   * run for this order" — see ShipmentModel) from that shipment's own agency's
   * `policies.pricing`. Callers need both views and they are not
   * interchangeable:
   *  - `byShipment` is what each shipment is charged, and is snapshotted onto the
   *    shipment so the delivery-time split divides the same number the vendor was
   *    charged.
   *  - `byAgency` sums those, and is only used to reduce the vendor's net. An
   *    agency can have more than one shipment on the same order (e.g. a late item
   *    routed to a new shipment after the first left `pending`/`assigned` — see
   *    ShipmentRepository.findGroupableByOrderAndAgency), and the vendor is
   *    charged for every one of them.
   *
   * The payment-time split no longer creates agency allocations, so the
   * `(order, agency)` uniqueness collision that used to force this summing is
   * gone: the delivery-time rows are sourced by SHIPMENT id, which is unique per
   * run by construction.
   */
  private async computeAgencyDeliveryFees(
    order: IOrder
  ): Promise<{
    byAgency: Map<string, number>;
    byShipment: Map<string, number>;
    /** Σ per shipment of the part of its fee the customer did NOT pay (ADR-A11). */
    vendorBorneTotal: number;
    /** Per shipment: what the customer paid above its fee (owed back), only where > 0. */
    customerExcessByShipment: Map<string, number>;
  }> {
    const orderId = (order._id as any).toString();
    const byAgency = new Map<string, number>();
    const byShipment = new Map<string, number>();
    const customerExcessByShipment = new Map<string, number>();
    let vendorBorneTotal = 0;

    const shipments = await this.shipmentRepo.findByOrderId(orderId);
    if (shipments.length === 0) return { byAgency, byShipment, vendorBorneTotal, customerExcessByShipment }; // defensive: no shipments yet for a paid physical order

    // Batch-fetch every distinct agency's policy in ONE query (avoid N+1).
    const agencyIds = [...new Set(shipments.map((s) => s.agency_id.toString()))];
    const agencies = await this.agencyRepo.findByIds(agencyIds);
    const policyByAgency = new Map(agencies.map((a) => [(a._id as any).toString(), a.policies]));

    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));

    for (const shipment of shipments) {
      const agencyId = shipment.agency_id.toString();
      const shipmentFee = this.computeShipmentDeliveryFee(
        shipment,
        policyByAgency.get(agencyId) ?? null,
        orderItemsById,
        orderId,
        order.delivery_address?.components?.region ?? null
      );
      const shipmentId = (shipment._id as any).toString();
      byShipment.set(shipmentId, shipmentFee);
      byAgency.set(agencyId, (byAgency.get(agencyId) ?? 0) + shipmentFee);
      const shares = deliveryFeeShares(shipmentFee, customerDeliveryFeeOf(order, shipment));
      vendorBorneTotal += shares.vendorBorne;
      if (shares.customerExcess > 0) customerExcessByShipment.set(shipmentId, shares.customerExcess);
    }

    // NOTE(earnings): additional_fees.cod_handling_fee is charged only on COD
    // collections (see splitCodCollection) — prepaid orders never trigger it.
    // NOTE(earnings): additional_fees.rto_fee IS now charged, but not here —
    // it replaces the delivery fee at delivery time when a shipment comes back
    // rather than being delivered. See resolveEarnedFee.
    // TODO(earnings): additional_fees.peak_season_surcharge — deferred. No
    // "peak season" concept is defined anywhere in the codebase.
    // TODO(earnings): additional_fees.failed_delivery_fee — deferred. Unlike
    // rto_fee it is not a division of the fee already charged but an EXTRA
    // charge to the vendor for a wasted attempt, and 'failed' is not terminal
    // (failed → in_transit | returned), so a shipment can fail repeatedly. It
    // needs its own charge path, not a slice of this one.

    return { byAgency, byShipment, vendorBorneTotal, customerExcessByShipment };
  }

  /**
   * ONE shipment's delivery fee — delegated to {@link EarningsQuoteService},
   * which owns the formula so that the agent's OFFER-TIME estimate and this
   * DELIVERY-TIME actual are provably the same arithmetic. Every deferred
   * pricing component is documented there.
   */
  private computeShipmentDeliveryFee(
    shipment: IShipment,
    policies: IAgencyPolicies | null,
    orderItemsById: Map<string, IOrderItem>,
    orderId: string,
    deliveryRegion: string | null
  ): number {
    return this.quotes.computeShipmentDeliveryFee(shipment, policies, orderItemsById, orderId, deliveryRegion);
  }

  /**
   * Split ONE verified COD collection (one shipment's cash handoff): platform
   * commission, agency delivery fee + COD handling fee, vendor net — all on
   * that shipment's portion of the order.
   *
   * Differences from the prepaid split:
   *  - Source is the CashCollection (COD orders collect per shipment).
   *  - `requires_cash_settlement: true` — release additionally waits for the
   *    physical cash to be remitted and confirmed (Agent → Agency → Platform,
   *    see cod-settlement.service).
   *
   * Like prepaid, these allocations are created with NO completion date and so
   * no hold window: escrow is resolved per ORDER, not per shipment, and
   * `OrderCompletionService` stamps them when the whole order completes (see
   * EarningsCompletionService.onOrderCompleted).
   *
   * This reverses an earlier design in which a COD collection was treated as
   * self-completing, on the grounds that the verified delivery code IS that
   * shipment's customer confirmation. True as far as it goes — but it made one
   * shipment's money releasable while its siblings were still out for delivery,
   * so the actors on a split order were paid at different times for the same
   * order. Every actor now matures together, on the order.
   *  - The agency's `additional_fees.cod_handling_fee` is charged here
   *    (percentage of the collected amount, or fixed per collection), paid by
   *    the vendor like the delivery fee.
   *
   * The reconciliation, with the AI margin (BARGAINING-AGENT-PLAN D-5):
   *   gross = aiMargin + commission + agency + agent + vendorNet
   *
   * ⚠ **The AI margin here is computed over THIS SHIPMENT'S lines, not the
   * order's.** `gross` is `collection.expected_amount`, which is
   * `Σ orderItem.price × shipmentItem.quantity` — one shipment's slice of the
   * order, and an order item can be split across shipments. Using the order
   * items' own quantities would allocate the whole order's margin once per
   * collection, over-allocating on a multi-shipment order and potentially driving
   * `vendorNet` negative. `computeShipmentAiMargin` is the join.
   */
  async splitCodCollection(order: IOrder, collection: ICashCollection): Promise<void> {
    // A fee-only collection (an ONLINE order whose customer paid the delivery fee to the rider,
    // W-F) carries no goods: it pays the agency side only. Every caller of this method (collect,
    // auto-collect, the recovery sweep) reaches it through here.
    if (collectionKindOf(collection) === 'delivery_fee') return this.splitDeliveryFeeCollection(order, collection);

    const sourceId = collection._id.toString();
    if (await this.allocationRepo.existsForSource('cod_collection', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    // ADR-A11: the collection's cash is goods + the delivery fee a customer-paid shipment's
    // customer hands over. The vendor is measured on the GOODS (gross_snapshot, commission, the
    // COD fee's base — D-3, D-5); the delivery cash belongs to the agency side.
    const { itemsAmount, deliveryFeeAmount: customerDeliveryCash } = collectionBreakdownOf(collection);
    const currency = collection.currency;
    const agencyId = collection.agency_id.toString();

    const [shipment, agency] = await Promise.all([
      this.shipmentRepo.findById(collection.shipment_id.toString()),
      this.agencyRepo.findById(agencyId),
    ]);
    if (!shipment) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, {
        shipmentId: collection.shipment_id.toString(),
      });
    }

    const agentId = collection.agent_id.toString();
    const {
      gross,
      aiMargin,
      commissionPercent,
      commission,
      deliveryFee,
      vendorBorneDelivery,
      customerExcess,
      codFee,
      agentCut,
      agencyCut,
      vendorNet,
    } = await this.computeCodCollectionSplit(order, {
      shipment,
      policies: agency?.policies ?? null,
      agentId,
      agencyId,
      itemsAmount,
      deliveryFeeAmount: customerDeliveryCash,
    });

    // Record it for audit. COD computes the fee once, at collection, so it cannot
    // drift the way a prepaid order's can — but nothing else persists what a
    // delivery was charged, and an agency questioning a payout has no other
    // record to check against.
    await this.shipmentRepo.setDeliveryFeeSnapshots(
      new Map([[(shipment._id as any).toString(), deliveryFee]])
    );

    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        aiMargin,
        commission,
        deliveryFee,
        vendorBorneDelivery,
        codFee,
      });
    }
    // Delivery cash above the fee is the customer's (only after a fee decrease — W-E).
    if (customerExcess > 0) {
      await this.shipmentRepo.setCustomerFeeRefundable(
        new Map([[(shipment._id as any).toString(), customerExcess]])
      );
    }

    // If the order has ALREADY completed, inherit its maturity rather than
    // waiting for a completion event that has been and gone. Two paths reach
    // here after completion and both would otherwise strand this money as held
    // forever: the collect path completes the order (the delivery code is the
    // customer's confirmation) BEFORE splitting, and the daily sweep re-splits
    // collections whose split never landed, long after the fact.
    const orderCompletedAt = deliveredAtOf(order); // the order's hold start (delivery since 2026-10-05; completion as fallback)
    const codDefaults = {
      source_type: 'cod_collection' as const,
      source_id: sourceId,
      gross_snapshot: gross,
      commission_percent_snapshot: commissionPercent,
      currency,
      requires_cash_settlement: true,
      ...(orderCompletedAt
        ? {
            completed_at: orderCompletedAt,
            hold_release_at: daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, orderCompletedAt),
          }
        : {}),
    };

    const allocations: CreateAllocationInput[] = [
      { ...codDefaults, beneficiary_type: 'vendor', beneficiary_id: vendorId, amount: vendorNet },
      { ...codDefaults, beneficiary_type: 'platform', beneficiary_id: null, amount: commission },
      // One agency row per collection: what's left of the delivery fee after the
      // agent's cut, plus the whole COD handling fee. The handling fee stays with
      // the agency deliberately — fee_split is defined as a share "of the delivery
      // fee", and the agency is the party carrying the cash-accountability (it is
      // their balance the rolling reserve is held against).
      {
        ...codDefaults,
        beneficiary_type: 'agency',
        beneficiary_id: agencyId,
        amount: agencyCut,
      },
      // The agent is paid by the PLATFORM, like any other beneficiary — hold →
      // release → available → payout. `requires_cash_settlement` is inherited
      // from codDefaults, so the agent's own cut is not releasable until the cash
      // they collected has physically reached the platform. That is deliberate:
      // an agent must not be able to withdraw a cut of money they are still
      // holding, or never handed back.
      { ...codDefaults, beneficiary_type: 'agent', beneficiary_id: agentId, amount: agentCut },
      // The bargaining agent's share of THIS shipment's uplift — see the
      // docstring. Zero on an ordinary collection, and `persist` skips a
      // zero-value row, so nothing is written for one.
      { ...codDefaults, beneficiary_type: 'platform_ai', beneficiary_id: null, amount: aiMargin },
    ];

    await this.persist(allocations);

    await this.emitSplit('cod_collection', sourceId, vendorId, {
      gross,
      aiMargin,
      commission,
      deliveryFee,
      vendorBorneDelivery,
      customerDeliveryCash,
      codFee,
      agentCut,
      vendorNet,
    });
  }

  /**
   * The arithmetic of `splitCodCollection`, with no write — shared with the administrator's
   * money-split view, which runs it BEFORE the cash is collected (and before an agent is bound:
   * `agentId: null` yields a cut of 0, which is what a split with no agent would pay; the view
   * labels it as not yet known).
   *
   * ⚠ The bargain fee is over THIS SHIPMENT's lines with the shipment's quantities — see
   * `computeShipmentAiMargin` and the docstring of `splitCodCollection`.
   */
  async computeCodCollectionSplit(
    order: IOrder,
    input: CodCollectionSplitInput
  ): Promise<CodCollectionSplitComputation> {
    const gross = input.itemsAmount;
    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));

    // Per-shipment, for the reason in `splitCodCollection`'s docstring. Computed before the
    // commission because the commission is a percentage of what is left after it.
    const aiMargin = this.computeShipmentAiMargin(input.shipment, orderItemsById);
    const vendorGross = gross - aiMargin;

    const { commissionPercent } = await this.entitlements.getEntitlements(order.vendor_id.toString());
    const commission = Math.floor((vendorGross * commissionPercent) / 100);

    const deliveryFee = this.computeShipmentDeliveryFee(
      input.shipment,
      input.policies,
      orderItemsById,
      order._id.toString(),
      order.delivery_address?.components?.region ?? null
    );
    // What the vendor bears of it: all of it when vendor-paid; nothing when the customer paid it
    // in cash (only a fee raised above the cash collected would leave a remainder).
    const shares = deliveryFeeShares(deliveryFee, input.deliveryFeeAmount);

    // D-5: on the GOODS only — never on the delivery fee the agent also collects.
    const codFee = computeCodHandlingFee(input.policies?.pricing?.additional_fees?.cod_handling_fee, gross);

    // The agent's cut comes OUT of the delivery fee, not on top of it: the
    // vendor pays the same either way, and the agency shares the fee with the
    // person who actually made the delivery.
    const agentCut = input.agentId ? await this.computeAgentCut(input.agentId, input.agencyId, deliveryFee) : 0;

    return {
      gross,
      aiMargin,
      commissionPercent,
      commission,
      deliveryFee,
      vendorBorneDelivery: shares.vendorBorne,
      customerExcess: shares.customerExcess,
      codFee,
      agentCut,
      agencyCut: computeAgencyCut(deliveryFee, agentCut, codFee),
      vendorNet: vendorGross - commission - shares.vendorBorne - codFee,
    };
  }

  /**
   * Split ONE fee-only cash collection (ADR-A11 § Cash for delivery, W-F): the customer paid the
   * goods ONLINE and handed the rider the delivery fee in cash.
   *
   * ── The accounting ───────────────────────────────────────────────────────────
   *
   * The cash is the AGENCY SIDE's (D-3) and travels the existing cash chain exactly like the
   * delivery-fee part of a customer-paid COD collection: agent → agency (`AgentDeposit`) →
   * platform (`AgencyRemittance` FIFO, which stamps `cash_settled_at` on these rows) → the
   * agency and the agent are paid by the platform, once, from these rows. So:
   *
   *  - rows: `agency` = fee − agentCut, `agent` = agentCut — NOTHING for the vendor, the
   *    platform or `platform_ai` (no commission on delivery, D-3; the goods were split by
   *    `splitOrder` at payment);
   *  - `requires_cash_settlement: true` on both — the platform never releases money it has not
   *    physically received;
   *  - `splitShipmentDelivery` writes NOTHING for a delivered cash-fee shipment, so the agency is
   *    paid exactly once (here), never also "from the platform at delivery";
   *  - `gross_snapshot` = the agency's fee, `commission_percent_snapshot` = 0 (like the
   *    prepaid shipment rows).
   *
   * The fee divided is the agency's fee (override → snapshot), not the cash: normally equal. A
   * vendor-borne remainder (fee > cash, only after a change-agency difference the vendor covered,
   * D-10) was already deducted from the vendor's net at `splitOrder` and sits with the platform,
   * so the rows still sum to the fee. Cash ABOVE the fee (not reachable in the normal flow — a
   * decrease re-prices the pending collection) is recorded as `customer_fee_refundable`.
   */
  async splitDeliveryFeeCollection(order: IOrder, collection: ICashCollection): Promise<void> {
    const sourceId = collection._id.toString();
    if (await this.allocationRepo.existsForSource('cod_collection', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    const currency = collection.currency;
    const agencyId = collection.agency_id.toString();
    const { deliveryFeeAmount: cash } = collectionBreakdownOf(collection);

    const [shipment, agency] = await Promise.all([
      this.shipmentRepo.findById(collection.shipment_id.toString()),
      this.agencyRepo.findById(agencyId),
    ]);
    if (!shipment) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, {
        shipmentId: collection.shipment_id.toString(),
      });
    }

    const agentId = collection.agent_id.toString();
    const { deliveryFee, vendorBorneDelivery, customerExcess, agentCut, agencyCut } =
      await this.computeDeliveryFeeCollectionSplit(order, {
        shipment,
        policies: agency?.policies ?? null,
        agentId,
        agencyId,
        cash,
      });
    if (customerExcess > 0) {
      await this.shipmentRepo.setCustomerFeeRefundable(
        new Map([[(shipment._id as any).toString(), customerExcess]])
      );
    }

    const orderCompletedAt = deliveredAtOf(order); // the order's hold start (delivery since 2026-10-05; completion as fallback)
    const defaults = {
      source_type: 'cod_collection' as const,
      source_id: sourceId,
      gross_snapshot: deliveryFee,
      commission_percent_snapshot: 0,
      currency,
      requires_cash_settlement: true,
      ...(orderCompletedAt
        ? {
            completed_at: orderCompletedAt,
            hold_release_at: daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, orderCompletedAt),
          }
        : {}),
    };

    await this.persist([
      { ...defaults, beneficiary_type: 'agency', beneficiary_id: agencyId, amount: agencyCut },
      { ...defaults, beneficiary_type: 'agent', beneficiary_id: agentId, amount: agentCut },
    ]);

    await this.emitSplit('cod_collection', sourceId, vendorId, {
      deliveryFee,
      customerDeliveryCash: cash,
      vendorBorneDelivery,
      agentCut,
      agencyNet: deliveryFee - agentCut,
    });
  }

  /**
   * The arithmetic of `splitDeliveryFeeCollection`, with no write — shared with the
   * administrator's money-split view. `agentId: null` ⇒ a cut of 0 (the view labels it).
   */
  async computeDeliveryFeeCollectionSplit(
    order: IOrder,
    input: { shipment: IShipment; policies: IAgencyPolicies | null; agentId: string | null; agencyId: string; cash: number }
  ): Promise<{ deliveryFee: number; vendorBorneDelivery: number; customerExcess: number; agentCut: number; agencyCut: number }> {
    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    const deliveryFee = this.computeShipmentDeliveryFee(
      input.shipment,
      input.policies,
      orderItemsById,
      order._id.toString(),
      order.delivery_address?.components?.region ?? null
    );
    const shares = deliveryFeeShares(deliveryFee, input.cash);
    const agentCut = input.agentId ? await this.computeAgentCut(input.agentId, input.agencyId, deliveryFee) : 0;
    return {
      deliveryFee,
      vendorBorneDelivery: shares.vendorBorne,
      customerExcess: shares.customerExcess,
      agentCut,
      // No COD handling fee: the goods were not cash (D-5 — the fee is on the product price).
      agencyCut: computeAgencyCut(deliveryFee, agentCut),
    };
  }

  /**
   * The AI margin owed on ONE shipment's slice of an order.
   *
   * Joins each `IShipmentItem` back to its order item — the same join
   * `CashCollectionService.computeExpectedAmount` does to derive the cash to
   * collect — and takes the price and floor from the order item while taking the
   * **quantity from the shipment item**. That pairing is the whole point: it is
   * what makes this margin a share of exactly the uplift inside
   * `collection.expected_amount`, so the two reconcile.
   *
   * An unknown `order_item_id` is SKIPPED rather than thrown on, unlike
   * `computeExpectedAmount`, which hard-throws. The asymmetry is deliberate:
   * there, a missing join means the platform does not know how much cash to
   * collect, and guessing is worse than failing. Here it means the platform
   * cannot read that line's floor — so it takes nothing, the vendor keeps
   * the whole line, and the money still reconciles. Failing the split instead
   * would strand a delivered COD collection nobody is ever paid for.
   */
  private computeShipmentAiMargin(
    shipment: IShipment,
    orderItemsById: Map<string, IOrderItem>
  ): number {
    return computeOrderAiMargin(
      shipment.items.flatMap((shipmentItem) => {
        const orderItem = orderItemsById.get(shipmentItem.order_item_id.toString());
        if (!orderItem) return [];
        // Same floor as the prepaid path, with the SHIPMENT's quantity.
        return [{ ...bargainLineOf(orderItem), quantity: shipmentItem.quantity }];
      })
    );
  }

  /**
   * Divide ONE prepaid shipment's delivery fee between the agency and the agent
   * who ran it — the online-paid mirror of `splitCodCollection`.
   *
   * This is where an agent finally gets paid on an ONLINE-paid order. The fee was
   * charged to the vendor at payment (`splitOrder`) but held back from allocation
   * because no agent existed yet; now the run is over and `shipment.agent_id` is
   * whoever actually made it — including after a reassignment, where that is not
   * the agent who picked the parcel up.
   *
   * Called at `agent_delivered`, NOT at the customer's confirmation: the agent
   * must learn what they earned when they finish the job, and a customer who
   * never clicks confirm must not be able to withhold it. That is safe because
   * the rows are created `held` with no maturity — they still cannot be released
   * until the ORDER completes and the HOLD_DAYS window elapses, exactly like
   * every other actor's share.
   *
   * Also called at `returned`, where the run happened but the delivery did not:
   * the agency earns its own `rto_fee` instead (see resolveEarnedFee), the agent
   * their contracted cut of that, and the unspent remainder goes back to the
   * vendor so the order's gross still reconciles.
   *
   * COD never reaches here — `splitCodCollection` already pays all four parties
   * off the collection, and a returned COD shipment collected no cash, so there
   * is nothing to divide.
   */
  async splitShipmentDelivery(
    order: IOrder,
    shipment: IShipment,
    outcome: ShipmentDeliveryOutcome
  ): Promise<void> {
    if (order.payment_method === 'cash_on_delivery') return; // paid via splitCodCollection
    if (order.order_type !== 'physical') return; // no shipments, no delivery fee

    const sourceId = (shipment._id as any).toString();
    if (await this.allocationRepo.existsForSource('shipment', sourceId)) return; // idempotent

    // ── The delivery fee was paid to the rider in CASH (W-F) ──────────────────────
    // Delivered: the agency and agent are paid from the fee-only collection
    // (`splitDeliveryFeeCollection`) — splitting here too would pay the agency twice.
    // Returned: no cash was collected (the collection is cancelled) and, like a COD return, the
    // run earns nothing; the only money the platform holds for it is a vendor-borne remainder
    // (`splitOrder` deducted it from the vendor's net), which goes back to the vendor.
    if (paysDeliveryFeeInCash(order, shipment)) {
      if (outcome !== 'returned') return;
      const agency = await this.agencyRepo.findById(shipment.agency_id.toString());
      const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
      const reservedFee = shipment.delivery_fee_snapshot ?? this.computeShipmentDeliveryFee(
        shipment,
        agency?.policies ?? null,
        orderItemsById,
        order._id.toString(),
        order.delivery_address?.components?.region ?? null
      );
      const vendorBorne = deliveryFeeShares(reservedFee, customerDeliveryFeeOf(order, shipment)).vendorBorne;
      const orderCompletedAtCash = deliveredAtOf(order); // the order's hold start (delivery since 2026-10-05; completion as fallback)
      await this.persist([
        {
          source_type: 'shipment',
          source_id: sourceId,
          gross_snapshot: reservedFee,
          commission_percent_snapshot: 0,
          currency: order.currency,
          requires_cash_settlement: false,
          beneficiary_type: 'vendor',
          beneficiary_id: order.vendor_id.toString(),
          amount: vendorBorne,
          ...(orderCompletedAtCash
            ? {
                completed_at: orderCompletedAtCash,
                hold_release_at: daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, orderCompletedAtCash),
              }
            : {}),
        },
      ]);
      return;
    }

    const orderId = order._id.toString();
    const vendorId = order.vendor_id.toString();
    const agencyId = shipment.agency_id.toString();
    const currency = order.currency;

    // Orders paid BEFORE the fee was deferred already banked the agency's whole
    // delivery fee at payment time, as an ('order', agency) row. Splitting again
    // here would pay it twice. Those orders keep the old behaviour and the agent
    // goes unpaid on them — the alternative is inventing money that was never
    // reserved for it.
    const orderAllocations = await this.allocationRepo.findBySource('order', orderId);
    const legacyAgencyRow = orderAllocations.find(
      (a) => a.beneficiary_type === 'agency' && a.beneficiary_id?.toString() === agencyId
    );
    if (legacyAgencyRow) {
      console.warn(
        `[EarningsSplitService] Shipment ${sourceId} belongs to order ${orderId}, which was split ` +
          `under the payment-time agency allocation; skipping the delivery split to avoid paying ` +
          `agency ${agencyId} twice.`
      );
      return;
    }

    const agency = await this.agencyRepo.findById(agencyId);
    const policies = agency?.policies ?? null;

    const { reservedFee, reservedFeeComputedLive, earnedFee, agentId, agentCut, agencyCut, vendorRefund, customerRefundable } =
      await this.computeShipmentDeliverySplit(order, shipment, outcome, policies);
    if (reservedFeeComputedLive) {
      console.error(
        `[EarningsSplitService] Shipment ${sourceId} (order ${orderId}) has no delivery_fee_snapshot — ` +
          `computing the fee live at ${reservedFee}. The vendor's net was not reduced by it.`
      );
    }
    if (customerRefundable > 0) {
      await this.shipmentRepo.setCustomerFeeRefundable(new Map([[sourceId, customerRefundable]]));
    }

    // Inherit the order's maturity when it has ALREADY completed, exactly as the
    // COD split does. A `returned` shipment can settle the last outstanding item
    // and the recovery sweep re-splits long after the fact; without this the rows
    // sit held forever, since findMaturedHeld skips a null hold_release_at.
    const orderCompletedAt = deliveredAtOf(order); // the order's hold start (delivery since 2026-10-05; completion as fallback)
    const shipmentDefaults = {
      source_type: 'shipment' as const,
      source_id: sourceId,
      // What this row divides — the fee, not the order total. The order's gross
      // and the commission taken off it live on the ('order', …) rows; no
      // commission is charged a second time here, hence 0.
      gross_snapshot: reservedFee,
      commission_percent_snapshot: 0,
      currency,
      // The money is already at the platform (the customer paid the gateway), so
      // unlike COD there is no cash chain to wait on.
      requires_cash_settlement: false,
      ...(orderCompletedAt
        ? {
            completed_at: orderCompletedAt,
            hold_release_at: daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, orderCompletedAt),
          }
        : {}),
    };

    const allocations: CreateAllocationInput[] = [
      {
        ...shipmentDefaults,
        beneficiary_type: 'agency',
        beneficiary_id: agencyId,
        amount: agencyCut,
      },
      // Paid by the PLATFORM like any other beneficiary — hold → release →
      // available → payout — even though it is the AGENCY that owes it under the
      // contract's fee_split. Nobody is paid off-platform.
      ...(agentId
        ? [
            {
              ...shipmentDefaults,
              beneficiary_type: 'agent' as const,
              beneficiary_id: agentId,
              amount: agentCut,
            },
          ]
        : []),
      // A run that earned less than was reserved for it returns the difference to
      // the vendor, who was charged the full fee at payment. Zero on a normal
      // delivery, and `persist` drops zero-value rows.
      {
        ...shipmentDefaults,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        amount: vendorRefund,
      },
    ];

    await this.persist(allocations);

    await this.emitSplit('shipment', sourceId, vendorId, {
      reservedFee,
      earnedFee,
      agentCut,
      agencyNet: earnedFee - agentCut,
      vendorRefund,
      customerRefundable,
    });
  }

  /**
   * The arithmetic of `splitShipmentDelivery`'s ordinary branch (prepaid, fee not paid in cash),
   * with no write — shared with the administrator's money-split view, which runs it before the
   * run is over with `outcome: 'delivered'` (the question being asked) or `'returned'`.
   */
  async computeShipmentDeliverySplit(
    order: IOrder,
    shipment: IShipment,
    outcome: ShipmentDeliveryOutcome,
    policies: IAgencyPolicies | null
  ): Promise<ShipmentDeliverySplitComputation> {
    const agencyId = shipment.agency_id.toString();

    // The fee the vendor was actually charged. Recomputing would risk dividing a
    // different number than was charged if the agency edited its pricing since —
    // see IShipment.delivery_fee_snapshot. A missing snapshot means the shipment
    // was created after its order was split (a late item routed to a new
    // shipment), so nothing was ever charged for it; compute live (the caller logs),
    // since that allocation is not covered by the vendor's net.
    let reservedFee = shipment.delivery_fee_snapshot ?? null;
    const reservedFeeComputedLive = reservedFee === null;
    if (reservedFee === null) {
      const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
      reservedFee = this.computeShipmentDeliveryFee(
        shipment,
        policies,
        orderItemsById,
        order._id.toString(),
        order.delivery_address?.components?.region ?? null
      );
    }

    const earnedFee = resolveEarnedFee(outcome, reservedFee, policies);
    // The agent's cut comes OUT of what the run earned, never on top: the vendor
    // pays the same either way and the agency shares with whoever did the work.
    // A shipment can end `returned` with no agent ever bound (the agency took it
    // back before anyone accepted) — then there is no cut and the agency keeps it.
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    const agentCut = agentId ? await this.computeAgentCut(agentId, agencyId, earnedFee) : 0;
    // The unspent `reserved − earned` goes back to whoever paid it (ADR-A11): the customer
    // first, up to what their payment covered, then the vendor. Vendor-paid: all to the vendor
    // (an allocation row, as before). Customer-paid: NO vendor row — the platform holds it, owed
    // to the customer, recorded on `shipment.customer_fee_refundable` for W-E's refund.
    const customerFee = customerDeliveryFeeOf(order, shipment);
    const feeShares = deliveryFeeShares(reservedFee, customerFee);
    const leftover = rtoLeftoverShares(reservedFee, earnedFee, feeShares.customerCovered);

    return {
      reservedFee,
      reservedFeeComputedLive,
      earnedFee,
      agentId,
      agentCut,
      // No COD handling fee on a prepaid delivery — there was no cash to handle.
      agencyCut: computeAgencyCut(earnedFee, agentCut),
      vendorRefund: leftover.toVendor,
      customerRefundable: leftover.toCustomer + feeShares.customerExcess,
    };
  }

  /**
   * The agent's share of one delivery's fee, per the contract they made the
   * delivery under (`fee_split`).
   *
   * Clamped to the delivery fee. A flat fee negotiated above what the delivery
   * actually earns would otherwise drive the agency's allocation negative, and
   * an allocation cannot be negative — the platform can only divide the fee it
   * collected, not invent the shortfall. The agency is free to make up the
   * difference off-platform; it is logged because a contract that routinely
   * clamps is mispriced, not merely unlucky.
   *
   * No live contract → no cut. The cash still has to be accounted for and the
   * split must not fail, so the fee stays whole with the agency and the anomaly
   * is logged. This mirrors the attribution gap in
   * CashCollectionService.attributeToContractInSession and has the same cause: a
   * contract terminated with a shipment still in flight.
   *
   * The arithmetic itself lives in {@link EarningsQuoteService} so the agent's
   * offer-time estimate cannot drift from what this actually pays.
   */
  private async computeAgentCut(
    agentId: string,
    agencyId: string,
    deliveryFee: number
  ): Promise<number> {
    return await this.quotes.computeAgentCut(agentId, agencyId, deliveryFee);
  }

  /**
   * Split a paid booking (service product): platform commission + vendor net.
   * Bookings have no delivery agency.
   */
  async splitBooking(booking: IBooking): Promise<void> {
    const sourceId = booking._id.toString();
    if (await this.allocationRepo.existsForSource('booking', sourceId)) return; // idempotent

    const vendorId = booking.vendorId.toString();
    const gross = booking.priceSnapshot;
    const currency = booking.currency;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((gross * commissionPercent) / 100);
    const vendorNet = gross - commission;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, { gross, commission });
    }

    const allocations: CreateAllocationInput[] = [
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: vendorNet,
        currency,
      },
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'platform',
        beneficiary_id: null,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount: commission,
        currency,
      },
    ];

    await this.persist(allocations);

    await this.emitSplit('booking', sourceId, vendorId, { gross, commission, vendorNet });
  }

  /**
   * Split a booking's BALANCE payment — the extra collected when a service ran
   * longer or cost more than quoted.
   *
   * Same commission split as `splitBooking`, with two differences that matter:
   *
   * 1. **It matures immediately.** `splitBooking` allocations are held until the
   *    booking completes, but a balance only exists *because* it already has.
   *    Leaving these `held` with no completion left to trigger them is money
   *    held forever — the same failure mode `onOrderCompleted` guards against by
   *    sweeping every source type.
   * 2. **Idempotency is keyed on the payment, not the booking.** The unique index
   *    is (source_type, source_id, beneficiary), and `splitBooking` already owns
   *    `('booking', bookingId)` — so a balance split must carry its own source id
   *    or it would collide with the original and silently no-op.
   */
  async splitBookingBalance(booking: IBooking, amount: number): Promise<void> {
    if (amount <= 0) return;

    const bookingId = booking._id.toString();
    // Distinct source id, for the reason in the docstring above.
    const sourceId = booking.settlement?.balanceTransactionId?.toString() ?? bookingId;
    if (await this.allocationRepo.existsForSource('booking', sourceId)) return; // idempotent

    const vendorId = booking.vendorId.toString();
    const currency = booking.currency;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((amount * commissionPercent) / 100);
    const vendorNet = amount - commission;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross: amount,
        commission,
      });
    }

    await this.persist([
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'vendor',
        beneficiary_id: vendorId,
        gross_snapshot: amount,
        commission_percent_snapshot: commissionPercent,
        amount: vendorNet,
        currency,
      },
      {
        source_type: 'booking',
        source_id: sourceId,
        beneficiary_type: 'platform',
        beneficiary_id: null,
        gross_snapshot: amount,
        commission_percent_snapshot: commissionPercent,
        amount: commission,
        currency,
      },
    ]);

    // Start the hold clock now — see (1) above.
    try {
      await earningsCompletionService.onSourceCompleted('booking', sourceId);
    } catch (error) {
      console.error('[EarningsSplitService] Failed to mature booking balance allocations:', error);
    }

    await this.emitSplit('booking', sourceId, vendorId, {
      gross: amount,
      commission,
      vendorNet,
    });
  }

  /** Create allocations and hold each share — all in ONE transaction. */
  private async persist(allocations: CreateAllocationInput[]): Promise<void> {
    await transactionManager.runInTransaction(async (session) => {
      for (const input of allocations) {
        // Skip zero-value shares (e.g. 0% commission, no delivery fee) so we
        // don't create no-op ledger noise.
        if (input.amount <= 0) continue;
        const allocation = await this.allocationRepo.create(input, session);
        await this.accounts.holdInSession(allocation, session);
      }
    });
  }

  private async emitSplit(
    sourceType: EarningsSourceType,
    sourceId: string,
    vendorId: string,
    breakdown: Record<string, number>
  ): Promise<void> {
    try {
      await eventBus.publish('earnings.split', {
        eventType: 'earnings.split',
        aggregateId: sourceId,
        payload: { sourceType, sourceId, vendorId, ...breakdown },
        occurredAt: new Date(),
      });
    } catch (error) {
      console.error('[EarningsSplitService] Failed to emit earnings.split event:', error);
    }
  }
}

export const earningsSplitService = new EarningsSplitService();
