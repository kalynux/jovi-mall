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
import { ICashCollection } from '../../cod/models/cash-collection.model';
import {
  EarningsQuoteService,
  earningsQuoteService,
  computeAgencyCut,
  computeCodHandlingFee,
  resolveEarnedFee,
  ShipmentDeliveryOutcome,
} from './earnings-quote.service';

// The pure fee arithmetic lives in `EarningsQuoteService` — see its header. Both
// halves of every division are defined there (`applyFeeSplit` for the agent,
// `computeAgencyCut` for the agency, `computeCodHandlingFee`, `resolveEarnedFee`),
// so what an agent or agency is QUOTED and what this service ALLOCATES cannot
// drift. Re-exported here because this is where callers historically found them.
export { resolveEarnedFee };
export type { ShipmentDeliveryOutcome };

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
   *   gross = commission + vendorNet + Σ(agency + agent + vendor-refund per shipment)
   *
   * Digital orders have no shipments, so there is no delivery fee and nothing is
   * deferred. COD orders never reach this method at all — they have no payment to
   * split until the cash is collected (see `splitCodCollection`).
   */
  async splitOrder(order: IOrder): Promise<void> {
    const sourceId = order._id.toString();
    if (await this.allocationRepo.existsForSource('order', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    const gross = order.total_amount;
    const currency = order.currency;

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((gross * commissionPercent) / 100);

    // Per-shipment, policy-driven agency delivery fee (physical orders only —
    // digital orders have no shipments). See computeAgencyDeliveryFees for the
    // exact MINIMAL formula and every deferred pricing component.
    const { byAgency, byShipment } =
      order.order_type === 'physical'
        ? await this.computeAgencyDeliveryFees(order)
        : { byAgency: new Map<string, number>(), byShipment: new Map<string, number>() };
    const deliveryTotal = [...byAgency.values()].reduce((sum, v) => sum + v, 0);

    const vendorNet = gross - commission - deliveryTotal;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        commission,
        deliveryTotal,
      });
    }

    // Record what each shipment was charged BEFORE allocating anything. The
    // delivery-time split divides exactly these numbers rather than recomputing
    // from an agency policy that may have changed in the meantime — see
    // IShipment.delivery_fee_snapshot.
    await this.shipmentRepo.setDeliveryFeeSnapshots(byShipment);

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
    ];

    await this.persist(allocations);

    await this.emitSplit('order', sourceId, vendorId, {
      gross,
      commission,
      // Charged to the vendor now, allocated to the agency/agent at delivery.
      deliveryDeferred: deliveryTotal,
      vendorNet,
    });
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
  ): Promise<{ byAgency: Map<string, number>; byShipment: Map<string, number> }> {
    const orderId = (order._id as any).toString();
    const byAgency = new Map<string, number>();
    const byShipment = new Map<string, number>();

    const shipments = await this.shipmentRepo.findByOrderId(orderId);
    if (shipments.length === 0) return { byAgency, byShipment }; // defensive: no shipments yet for a paid physical order

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
        orderId
      );
      byShipment.set((shipment._id as any).toString(), shipmentFee);
      byAgency.set(agencyId, (byAgency.get(agencyId) ?? 0) + shipmentFee);
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

    return { byAgency, byShipment };
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
    orderId: string
  ): number {
    return this.quotes.computeShipmentDeliveryFee(shipment, policies, orderItemsById, orderId);
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
   */
  async splitCodCollection(order: IOrder, collection: ICashCollection): Promise<void> {
    const sourceId = collection._id.toString();
    if (await this.allocationRepo.existsForSource('cod_collection', sourceId)) return; // idempotent

    const vendorId = order.vendor_id.toString();
    const gross = collection.expected_amount;
    const currency = collection.currency;
    const agencyId = collection.agency_id.toString();

    const { commissionPercent } = await this.entitlements.getEntitlements(vendorId);
    const commission = Math.floor((gross * commissionPercent) / 100);

    const [shipment, agency] = await Promise.all([
      this.shipmentRepo.findById(collection.shipment_id.toString()),
      this.agencyRepo.findById(agencyId),
    ]);
    if (!shipment) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, {
        shipmentId: collection.shipment_id.toString(),
      });
    }

    const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
    const deliveryFee = this.computeShipmentDeliveryFee(
      shipment,
      agency?.policies ?? null,
      orderItemsById,
      order._id.toString()
    );
    // Record it for audit. COD computes the fee once, at collection, so it cannot
    // drift the way a prepaid order's can — but nothing else persists what a
    // delivery was charged, and an agency questioning a payout has no other
    // record to check against.
    await this.shipmentRepo.setDeliveryFeeSnapshots(
      new Map([[(shipment._id as any).toString(), deliveryFee]])
    );

    const codFee = computeCodHandlingFee(
      agency?.policies?.pricing?.additional_fees?.cod_handling_fee,
      gross
    );

    // The agent's cut comes OUT of the delivery fee, not on top of it: the
    // vendor pays the same either way, and the agency shares the fee with the
    // person who actually made the delivery.
    const agentId = collection.agent_id.toString();
    const agentCut = await this.computeAgentCut(agentId, agencyId, deliveryFee);

    const vendorNet = gross - commission - deliveryFee - codFee;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        commission,
        deliveryFee,
        codFee,
      });
    }

    // If the order has ALREADY completed, inherit its maturity rather than
    // waiting for a completion event that has been and gone. Two paths reach
    // here after completion and both would otherwise strand this money as held
    // forever: the collect path completes the order (the delivery code is the
    // customer's confirmation) BEFORE splitting, and the daily sweep re-splits
    // collections whose split never landed, long after the fact.
    const orderCompletedAt = order.completion?.confirmed_at ?? null;
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
        amount: computeAgencyCut(deliveryFee, agentCut, codFee),
      },
      // The agent is paid by the PLATFORM, like any other beneficiary — hold →
      // release → available → payout. `requires_cash_settlement` is inherited
      // from codDefaults, so the agent's own cut is not releasable until the cash
      // they collected has physically reached the platform. That is deliberate:
      // an agent must not be able to withdraw a cut of money they are still
      // holding, or never handed back.
      { ...codDefaults, beneficiary_type: 'agent', beneficiary_id: agentId, amount: agentCut },
    ];

    await this.persist(allocations);

    await this.emitSplit('cod_collection', sourceId, vendorId, {
      gross,
      commission,
      deliveryFee,
      codFee,
      agentCut,
      vendorNet,
    });
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

    // The fee the vendor was actually charged. Recomputing would risk dividing a
    // different number than was charged if the agency edited its pricing since —
    // see IShipment.delivery_fee_snapshot. A missing snapshot means the shipment
    // was created after its order was split (a late item routed to a new
    // shipment), so nothing was ever charged for it; compute live and log, since
    // that allocation is not covered by the vendor's net.
    let reservedFee = shipment.delivery_fee_snapshot ?? null;
    if (reservedFee === null) {
      const orderItemsById = new Map(order.items.map((i) => [(i._id as any).toString(), i]));
      reservedFee = this.computeShipmentDeliveryFee(shipment, policies, orderItemsById, orderId);
      console.error(
        `[EarningsSplitService] Shipment ${sourceId} (order ${orderId}) has no delivery_fee_snapshot — ` +
          `computing the fee live at ${reservedFee}. The vendor's net was not reduced by it.`
      );
    }

    const earnedFee = resolveEarnedFee(outcome, reservedFee, policies);
    // The agent's cut comes OUT of what the run earned, never on top: the vendor
    // pays the same either way and the agency shares with whoever did the work.
    // A shipment can end `returned` with no agent ever bound (the agency took it
    // back before anyone accepted) — then there is no cut and the agency keeps it.
    const agentId = shipment.agent_id ? shipment.agent_id.toString() : null;
    const agentCut = agentId ? await this.computeAgentCut(agentId, agencyId, earnedFee) : 0;
    const vendorRefund = reservedFee - earnedFee;

    // Inherit the order's maturity when it has ALREADY completed, exactly as the
    // COD split does. A `returned` shipment can settle the last outstanding item
    // and the recovery sweep re-splits long after the fact; without this the rows
    // sit held forever, since findMaturedHeld skips a null hold_release_at.
    const orderCompletedAt = order.completion?.confirmed_at ?? null;
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
        // No COD handling fee on a prepaid delivery — there was no cash to handle.
        amount: computeAgencyCut(earnedFee, agentCut),
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
    });
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
