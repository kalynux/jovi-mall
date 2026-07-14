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
import { ICashCollection } from '../../cod/models/cash-collection.model';

/**
 * EarningsSplitService - splits a freshly-paid order/booking into per-beneficiary
 * allocations and holds each share in escrow.
 *
 * The split runs at payment success so a vendor immediately sees their NET
 * (post-fee) earnings, even though the money stays held until the order is
 * completed. Idempotent: re-firing a payment webhook never double-splits
 * (guarded by a unique index on (source, beneficiary) plus an up-front check).
 *
 * The agency's per-order delivery-fee share is computed from that agency's
 * own `policies.pricing` (pickup-based and/or storage-based flat components),
 * derived from the order's real Shipment documents — not a flat per-agency
 * constant. See `computeAgencyDeliveryFees` below for the exact MINIMAL
 * formula and every deferred pricing component (kept as TODOs).
 *
 * All amounts are integers in minor currency units.
 */
export class EarningsSplitService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly entitlements: EntitlementService = entitlementService,
    private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository(),
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  /**
   * Split a paid order: platform commission, per-agency delivery fee, vendor net.
   * Digital orders have no delivery agency, so only commission + vendor net.
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
    const deliveryFeesByAgency =
      order.order_type === 'physical'
        ? await this.computeAgencyDeliveryFees(order)
        : new Map<string, number>();
    const deliveryTotal = [...deliveryFeesByAgency.values()].reduce((sum, v) => sum + v, 0);

    const vendorNet = gross - commission - deliveryTotal;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        commission,
        deliveryTotal,
      });
    }

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
      ...[...deliveryFeesByAgency.entries()].map(([agencyId, amount]) => ({
        source_type: 'order' as const,
        source_id: sourceId,
        beneficiary_type: 'agency' as const,
        beneficiary_id: agencyId,
        gross_snapshot: gross,
        commission_percent_snapshot: commissionPercent,
        amount,
        currency,
      })),
    ];

    await this.persist(allocations);

    await this.emitSplit('order', sourceId, vendorId, { gross, commission, deliveryTotal, vendorNet });
  }

  /**
   * Computes each agency's delivery-fee share for a physical order, per the
   * MINIMAL formula (see module docs), merged to ONE total per distinct
   * agency.
   *
   * Fee is computed PER SHIPMENT (the real unit of "one agency's one
   * delivery run for this order" — see ShipmentModel), from that shipment's
   * own agency's `policies.pricing`, then summed into one total per agency.
   * An agency can have more than one shipment on the same order (e.g. a late
   * item routed to a new shipment after the first left `pending`/`assigned`
   * — see ShipmentRepository.findGroupableByOrderAndAgency). Summing here —
   * rather than creating one allocation row PER SHIPMENT — is deliberate:
   * EarningsAllocation's uniqueness constraint is
   * `(source_type, source_id, beneficiary_type, beneficiary_id)`, i.e. one
   * row per (order, agency). Two shipments for the same agency on the same
   * order would collide on that index if each tried to insert its own row.
   * Summing preserves the existing constraint with zero schema change.
   */
  private async computeAgencyDeliveryFees(order: IOrder): Promise<Map<string, number>> {
    const orderId = (order._id as any).toString();
    const totals = new Map<string, number>();

    const shipments = await this.shipmentRepo.findByOrderId(orderId);
    if (shipments.length === 0) return totals; // defensive: no shipments yet for a paid physical order

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
      totals.set(agencyId, (totals.get(agencyId) ?? 0) + shipmentFee);
    }

    // NOTE(earnings): additional_fees.cod_handling_fee is charged only on COD
    // collections (see splitCodCollection) — prepaid orders never trigger it.
    // TODO(earnings): additional_fees.peak_season_surcharge — deferred. No
    // "peak season" concept is defined anywhere in the codebase.
    // TODO(earnings): additional_fees.failed_delivery_fee / rto_fee —
    // deferred. Natural hook: a new call from ShipmentService.updateStatus()
    // on a 'failed'/'returned' transition, once this base per-shipment split
    // has been validated in production. Not wired in this task.
    // TODO(agent): a delivery agent's own per-delivery cut is explicitly out
    // of scope for this task. No beneficiary_type: 'agent' allocation is
    // created anywhere in this service; EarningsOwnerType / beneficiary_type
    // stays 'vendor' | 'agency' | 'platform'. Intended future approach: a
    // flat fee per shipment once an agent is assigned, mirroring today's
    // placeholder DELIVERY_FLAT_FEE pattern. For COD, agencies pay their
    // agents off-platform in the meantime.

    return totals;
  }

  /**
   * ONE shipment's delivery fee from its agency's `policies.pricing` — the
   * MINIMAL formula shared by the prepaid per-order split (summed per agency)
   * and the COD per-collection split.
   */
  private computeShipmentDeliveryFee(
    shipment: IShipment,
    policies: IAgencyPolicies | null,
    orderItemsById: Map<string, IOrderItem>,
    orderId: string
  ): number {
    if (!policies) {
      // Defensive fallback, not expected in practice: AgencyOnboardingStep
      // POLICY_SETUP (step 4) is a REQUIRED onboarding step for agencies
      // (core/constants/onboarding-steps.ts), and only fully-onboarded
      // (onboarding_step: 0) agencies are selectable by vendors
      // (DeliveryAgencyRepository.findAvailableForVendors). So an agency
      // reachable by a dispatched shipment should always have `policies`
      // set. Charge the safe fallback constant (0 by default) rather than
      // a fabricated number, and log loudly so a real occurrence gets
      // investigated.
      console.error(
        `[EarningsSplitService] Agency ${shipment.agency_id.toString()} has no policies configured — ` +
          `falling back to EARNINGS_CONFIG.DELIVERY_FLAT_FEE for shipment ` +
          `${(shipment._id as any).toString()} (order ${orderId}).`
      );
      return EARNINGS_CONFIG.DELIVERY_FLAT_FEE;
    }

    let hasPickupBased = false;
    let hasStorageBased = false;
    for (const item of shipment.items) {
      const orderItem = orderItemsById.get(item.order_item_id.toString());
      const source = orderItem?.delivery?.pickup_location?.source;
      if (source === 'vendor_address') hasPickupBased = true;
      if (source === 'agency_storage') hasStorageBased = true;
      // else: no matching order item, or a legacy item with
      // pickup_location: null (predates this feature) — can't classify;
      // contributes no fee component.
    }

    let shipmentFee = 0;
    // A shipment mixing both fulfillment modes (each product
    // independently configured — see ShipmentService.getDetailForAgency)
    // is charged BOTH components: real distinct fulfillment work happens
    // for each class.
    if (hasPickupBased) {
      shipmentFee += policies.pricing.pickup_based.base_rate_first_kg;
      // TODO(earnings): additional_per_kg — deferred. Needs a weight
      // snapshot that doesn't exist on IOrderItem; weight only lives on
      // ProductVariant today. Add `+ additional_per_kg * extraKg` here
      // once order items snapshot a weight at checkout.
      // TODO(earnings): out_of_region_surcharge — deferred. No
      // region-matching concept (customer delivery region vs the vendor
      // pickup address / agency coverage_areas) exists anywhere yet.
    }
    if (hasStorageBased) {
      shipmentFee +=
        policies.pricing.storage_based.local_delivery_fee +
        policies.pricing.storage_based.pick_pack_fee_per_order;
      // TODO(earnings): out_of_region_delivery_fee — deferred, same
      // reason as pickup_based.out_of_region_surcharge above.
      // TODO(earnings): monthly_storage_fee_per_sku — intentionally
      // EXCLUDED from this per-order split. It's a recurring rent-style
      // charge (per SKU stored, per month), not tied to any single
      // order. Future work: bill it on its own recurring cadence
      // (separate job/module), not here.
    }

    // TODO(earnings): free_delivery — IOrderItem.delivery.free_delivery
    // is a per-item flag; this per-shipment computation doesn't consult
    // it, so a shipment carrying a free-delivery item is still charged
    // its flat component(s) in full. Revisit once fee calc needs
    // item-level granularity below the two shipment-level flat
    // components above.

    return shipmentFee;
  }

  /**
   * Split ONE verified COD collection (one shipment's cash handoff): platform
   * commission, agency delivery fee + COD handling fee, vendor net — all on
   * that shipment's portion of the order.
   *
   * Differences from the prepaid split:
   *  - Source is the CashCollection (COD orders collect per shipment).
   *  - Allocations are created ALREADY COMPLETED with the hold window running
   *    from `collected_at` — the verified delivery code IS the customer
   *    confirmation, so there is no separate completion step to wait for.
   *  - `requires_cash_settlement: true` — release additionally waits for the
   *    physical cash to be remitted and confirmed (Agent → Agency → Platform,
   *    see cod-settlement.service).
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

    const codFeeConfig = agency?.policies?.pricing?.additional_fees?.cod_handling_fee ?? null;
    const codFee = !codFeeConfig
      ? 0
      : codFeeConfig.type === 'percentage'
        ? Math.floor((gross * codFeeConfig.value) / 100)
        : codFeeConfig.value;

    const vendorNet = gross - commission - deliveryFee - codFee;
    if (vendorNet < 0) {
      throw createAppError(ERROR_CODES.EARNINGS_INVALID_SPLIT, 422, undefined, {
        gross,
        commission,
        deliveryFee,
        codFee,
      });
    }

    // Collection == verified delivery: allocations start completed, with the
    // hold window running from the handoff moment.
    const completedAt = collection.collected_at ?? new Date();
    const holdReleaseAt = daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, completedAt);
    const codDefaults = {
      source_type: 'cod_collection' as const,
      source_id: sourceId,
      gross_snapshot: gross,
      commission_percent_snapshot: commissionPercent,
      currency,
      requires_cash_settlement: true,
      completed_at: completedAt,
      hold_release_at: holdReleaseAt,
    };

    const allocations: CreateAllocationInput[] = [
      { ...codDefaults, beneficiary_type: 'vendor', beneficiary_id: vendorId, amount: vendorNet },
      { ...codDefaults, beneficiary_type: 'platform', beneficiary_id: null, amount: commission },
      // One agency row per collection: delivery fee + COD handling fee.
      { ...codDefaults, beneficiary_type: 'agency', beneficiary_id: agencyId, amount: deliveryFee + codFee },
    ];

    await this.persist(allocations);

    await this.emitSplit('cod_collection', sourceId, vendorId, {
      gross,
      commission,
      deliveryFee,
      codFee,
      vendorNet,
    });
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
