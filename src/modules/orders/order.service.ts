import mongoose, { ClientSession } from 'mongoose';
import { IOrder, OrderType, OrderPaymentMethod, FulfillmentStatus } from './order.model';
import { OrderRepository } from './order.repository';
import { CustomerModel } from '../customers/customer.model';
import { IGeoAddress, GeoAddressInput, toGeoAddress } from '../../core/types/geo-address.types';
import { canonicalizeAddressRegion } from '../../core/validation/address-country.helper';
import { CartService, CartResponse } from '../cart/services/cart.service';
import { transactionManager } from '../../core/database/transaction.manager';
import { ShipmentRepository } from '../shipments/shipment.repository';
import { IShipment, ShipmentModel, ShipmentStatus } from '../shipments/shipment.model';
import { IVendorCancellationPolicy } from '../vendors/vendor.model';
import { assertCancellationAllowed } from '../vendors/utils/cancellation-policy.util';
import { OrderTimelineRepository } from './order-timeline.repository';
import { TimelineActorType } from './order-timeline.model';
import { VendorRepository } from '../vendors/vendor.repository';
import { VendorSettingsRepository } from '../vendors/repositories/vendor-settings.repository';
import { OrderNumberGenerator } from './utils/order-number-generator';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { ProductRepositoryMongo } from '../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../catalog/repositories/mongo/variant.repository.mongo';
import { PriceResolverService } from '../catalog/domain/services/pricing-inventory/PriceResolverService';
import { ProductModel } from '../catalog/models/product.model';
import { bargainFloorsForVariants, displayPricesForVariants } from '../catalog/read-models/display-price.lookup';
import { ProductVariantModel } from '../catalog/models/product-variant.model';
import { VendorCustomerSyncService } from '../vendors/services/vendor-customer-sync.service';
import { eventBus } from '../../core/events/event-bus';
import { earningsSplitService } from '../earnings/services/earnings-split.service';
import { codEligibilityService } from '../cod/services/cod-eligibility.service';
import { codLimitsService, CodHandoffVerdict } from '../cod/services/cod-limits.service';
import { expectedCodAmount } from '../cod/domain/cod-limits';
import { orderStockService } from './services/order-stock.service';
import { belowMinimumError } from './services/delivery-cost-cap.service';
import { vendorOrderPricingService, regionOfGeo } from './services/vendor-order-pricing.service';
import { PricingLine } from './domain/vendor-order-pricing';
import { customerDeliveryFeeOf, orderItemsGrossOf } from './domain/delivery-payer';
import { MagazinRepository } from '../magazin/repositories/magazin.repository';
import {
  AGENT_IDENTITY_VISIBLE_FROM,
  CustomerShipmentDto,
  agentIdentityVisibleAt,
  toAgentDisplayName,
  toCustomerShipmentDto,
} from './dto/customer-shipment.dto';
import { resolveAgencyIdentities } from '../magazin/read-models/agency-identity.resolver';
import { resolveFileDetails } from '../catalog/read-models/file-detail.resolver';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider, IStorageProvider } from '../../core/storage';
// The repository directly, never the agents barrel: that barrel pulls in the auth
// middleware chain and closes a require cycle that crashes the boot — see the agent
// domain's own note about why routes are excluded from it.
import { AgentRepository } from '../agents/repositories/agent.repository';
import { OrderModel } from './order.model';

/**
 * OrderService - Cart-aware, payment-ready order management
 * 
 * BUSINESS RULES:
 * - Orders created ONLY from cart
 * - Orders can be 'physical' OR 'digital' (NEVER 'service')
 * - Physical orders create shipments
 * - Digital orders skip shipments (entitlements instead)
 * - All cart validation re-applied for defense in depth
 * 
 * VARIANT-FIRST ARCHITECTURE:
 * - All snapshots come from cart (which already has variant data)
 * - variant_id is required
 * - Cart data flows directly to order items
 * 
 * PAYMENT-READY:
 * - Idempotent payment success handler
 * - Branches fulfillment by order_type
 * - Safe for webhook retries
 */
/** Fulfillment states from which an order may still be cancelled (pre-shipment). */
export const CANCELLABLE_FULFILLMENT_STATES: FulfillmentStatus[] = ['pending', 'processing'];

/**
 * Shipment statuses past which a COD order is no longer cancellable: the package left the
 * agency (or already reached the customer), so the failed-delivery flow owns the outcome
 * from here.
 */
export const COD_NON_CANCELLABLE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned',
];

/**
 * How each dispatcher is described on the order timeline.
 *
 * A table rather than a ternary because the timeline is the one record a delivery dispute
 * reads, and a two-way branch would describe an ADMINISTRATOR's dispatch as
 * "auto-dispatched" — which is the exact fact in question when somebody asks why an order
 * left the vendor's hands. `metadata.auto` stays `actor.type === 'system'` and remains
 * correct.
 */
const DISPATCH_DESCRIPTION: Record<'vendor' | 'system' | 'admin', string> = {
  vendor: 'Vendor dispatched the order to its delivery agency',
  system: 'Order auto-dispatched to the delivery agency in charge',
  admin: 'An administrator dispatched the order to its delivery agency',
};

export class OrderService {
  private orderRepo: OrderRepository;
  private cartService: CartService;
  private shipmentRepo: ShipmentRepository;
  private timelineRepo: OrderTimelineRepository;
  private vendorRepo: VendorRepository;
  private vendorSettingsRepo: VendorSettingsRepository;
  private productRepo: ProductRepositoryMongo;
  private variantRepo: VariantRepositoryMongo;
  private vendorCustomerSync: VendorCustomerSyncService;
  /** An agency's business name lives on its Magazin, not on the DeliveryAgency. */
  private magazinRepo: MagazinRepository;
  /** Agency logos and agent photos are File references, resolved to `FileDetail`. */
  private fileRepository: FileRepositoryMongo;
  private storageProvider: IStorageProvider;
  /** Read-only, and only ever through `findPublicIdentitiesByIds` — see ADR-A06. */
  private agentRepo: AgentRepository;
  /**
   * Used for ONE thing: re-resolving the lines that carry a negotiation lock, so
   * their price can be re-validated and the lock consumed inside the order's own
   * transaction (BARGAINING-AGENT-PLAN D-12). Ordinary lines keep taking their
   * price from the cart snapshot — see `resolveNegotiatedLines`.
   */
  private priceResolver: PriceResolverService;

  constructor() {
    this.orderRepo = new OrderRepository();
    this.cartService = new CartService();
    this.shipmentRepo = new ShipmentRepository();
    this.timelineRepo = new OrderTimelineRepository();
    this.vendorRepo = new VendorRepository();
    this.vendorSettingsRepo = new VendorSettingsRepository();
    this.productRepo = new ProductRepositoryMongo();
    this.variantRepo = new VariantRepositoryMongo();
    this.vendorCustomerSync = new VendorCustomerSyncService();
    this.magazinRepo = new MagazinRepository();
    this.fileRepository = new FileRepositoryMongo();
    this.storageProvider = getStorageProvider();
    this.agentRepo = new AgentRepository();
    this.priceResolver = new PriceResolverService(this.productRepo, this.variantRepo);
  }

  /**
   * Cancel an order and notify. Single shared path used by the unpaid-order
   * auto-cancel sweep and the customer order-cancel endpoint.
   *
   * Sets `fulfillment_status = 'cancelled'` and (for unpaid orders) marks the
   * payment `failed`, appends a timeline entry, and publishes `order.cancelled`
   * (the event vendor notifications already listen for). Idempotent: a no-op if
   * the order is already cancelled. Applies to physical and digital orders.
   */
  /**
   * Refuse a cancellation that would move money or a parcel.
   *
   * ── Why this lives on the service ─────────────────────────────────────────
   * These six guards were inline in `customer-order.controller.ts`, along with the two
   * constants above, and `cancelOrder` itself checks only idempotency — deliberately, so
   * the unpaid-order sweep can call it directly. The moment a SECOND actor can cancel, a
   * controller-bound rule is a rule with one enforcer: the other caller either copies it
   * (and the two drift on a money question) or skips it (and the platform cancels a paid,
   * shipped order). Both are worse than a shared method.
   *
   * ── The one rule an administrator does not answer to ──────────────────────
   * `vendorPolicy` — the return window, the `cancellable` flag — is the VENDOR's
   * commercial promise to their CUSTOMER. The platform is not party to it, so an admin
   * cancellation skips it. Every other guard here is physical (a parcel is in a van) or
   * financial (money was taken), and binds an administrator exactly as it binds a
   * customer. If a second exemption is ever proposed, it needs a reason of that kind.
   */
  async assertCancellable(
    order: IOrder,
    opts: { actorType: 'customer' | 'admin'; vendorPolicy: IVendorCancellationPolicy | null }
  ): Promise<void> {
    if (order.fulfillment_status === 'cancelled') {
      throw createAppError(ERROR_CODES.ORDER_ALREADY_CANCELLED, 409);
    }
    if (!CANCELLABLE_FULFILLMENT_STATES.includes(order.fulfillment_status)) {
      throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
        fulfillmentStatus: order.fulfillment_status,
      });
    }

    // Orders have no firm delivery date, so delivery-based deadlines fall back to
    // creation-based handling.
    if (opts.actorType === 'customer') {
      assertCancellationAllowed(opts.vendorPolicy, {
        createdAt: order.created_at,
        isPending: order.fulfillment_status === 'pending',
      });
    }

    // Paid orders require a refund — out of scope for this eligibility-only path.
    if (order.payment_status === 'paid') {
      throw createAppError(ERROR_CODES.ORDER_CANCEL_REQUIRES_REFUND, 422);
    }
    if (order.payment_status !== 'pending' && order.payment_status !== 'AWAITING_PAYMENT') {
      throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
        paymentStatus: order.payment_status,
      });
    }

    // COD orders fulfil before payment, so "unpaid" alone isn't enough: once any package
    // left the agency (picked_up onwards) the handoff/failed-delivery flow owns the
    // outcome — no silent cancellation underneath it.
    if (order.payment_method === 'cash_on_delivery' && order.order_type === 'physical') {
      const inFlight = await ShipmentModel.countDocuments({
        order_id: order._id,
        status: { $in: COD_NON_CANCELLABLE_SHIPMENT_STATUSES },
      });
      if (inFlight > 0) {
        throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
          reason: 'A shipment is already out for delivery or has been handled',
        });
      }
    }
  }

  async cancelOrder(
    order: IOrder,
    // `TimelineActorType` rather than a fourth hand-written member: this value is passed
    // straight to `timelineRepo.appendEvent`'s `actorType`, whose enum has ALWAYS included
    // 'admin'. The local union was a narrower copy of that type, written before an
    // administrator could reach this method — and a copy of an enum is what drifts.
    opts: { actorType: TimelineActorType; actorId: string | null; reason?: string }
  ): Promise<void> {
    if (order.fulfillment_status === 'cancelled') return; // already terminal

    order.fulfillment_status = 'cancelled';
    // Unpaid orders never collected funds — mark the intent failed. A paid order
    // is never routed here (refunds own that path), so don't clobber 'paid'.
    // 'partially_paid' (COD) means cash WAS collected for part of the order —
    // never overwrite that financial fact either.
    if (
      order.payment_status !== 'paid' &&
      order.payment_status !== 'refunded' &&
      order.payment_status !== 'partially_paid'
    ) {
      order.payment_status = 'failed';
    }
    await order.save();

    /**
     * Give the units back.
     *
     * This is a **release**, not a restock: a cancellable order is by definition unpaid
     * (`assertCancellable` refuses `paid` with `ORDER_CANCEL_REQUIRES_REFUND`), so its
     * reservations are still `active` and nothing has been decremented. Flipping them to
     * `released` is the whole operation.
     *
     * A cash-on-delivery order is the exception worth knowing: it committed at creation, so
     * its reservations are `committed` and `StockReleaseService` correctly refuses them.
     * Those units went out on a van — they come back through the returned-shipment path as
     * a restock, not through here. The refusal is logged, not thrown.
     */
    await orderStockService.releaseForOrder(order);

    await this.timelineRepo.appendEvent({
      orderId: order._id.toString(),
      eventType: 'fulfillment.updated',
      description: opts.reason ?? 'Order cancelled',
      metadata: { newStatus: 'cancelled', reason: opts.reason ?? null },
      actorType: opts.actorType,
      actorId: opts.actorId,
    });

    await eventBus.publish('order.cancelled', {
      eventType: 'order.cancelled',
      aggregateId: order._id.toString(),
      payload: {
        orderId: order._id.toString(),
        vendorId: order.vendor_id.toString(),
        orderNumber: order.order_number,
        cancelledAt: new Date(),
      },
      occurredAt: new Date(),
    });
  }

  /**
   * The parcels on one of the caller's orders.
   *
   * Ownership is enforced by loading the order **scoped to this customer** first: a
   * `customer_id` mismatch is a `404 ORDER_NOT_FOUND`, the same answer as an order that does
   * not exist, so the endpoint cannot be used to probe whether an order id is real.
   *
   * The agency's identity comes from its Magazin (the source of truth for an agency's
   * business identity) via the platform's shared `AgencyIdentity` read model, and the
   * carrying agent's from `AgentRepository`. Both are batched across the order's shipments
   * rather than looked up per row: one order's parcels routinely span several agencies, and
   * after a reassignment they can span several agents too.
   *
   * ⚠ The agent block is a NARROW, REVOCABLE disclosure (ADR-A06). Two rules are enforced
   * here rather than in the DTO, because here is where the ids exist:
   *
   *  1. Only shipments inside the window are even looked up — an agent outside it is not
   *     fetched, so there is nothing in memory for a later projection to leak.
   *  2. The stored full name never reaches the DTO; `toAgentDisplayName` reduces it first.
   */
  async listShipmentsForCustomer(customerId: string, orderId: string): Promise<CustomerShipmentDto[]> {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    const order = await OrderModel.findOne({ _id: orderId, customer_id: customerId });
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    const shipments = await this.shipmentRepo.findByOrderId(orderId);
    if (shipments.length === 0) return [];

    // Only the agents the customer is entitled to see, and only for the shipments that
    // entitle them — see rule 1 above.
    const disclosableAgentIds = shipments
      .filter((s) => agentIdentityVisibleAt(s.status) && s.agent_id)
      .map((s) => s.agent_id!.toString());

    const [agencies, agentIdentities] = await Promise.all([
      resolveAgencyIdentities(
        shipments.map((s) => s.agency_id.toString()),
        this.magazinRepo,
        this.fileRepository,
        this.storageProvider,
      ),
      this.agentRepo.findPublicIdentitiesByIds(disclosableAgentIds),
    ]);

    const agentPhotos = await resolveFileDetails(
      [...agentIdentities.values()].map((a) => a.avatarFileId),
      this.fileRepository,
      this.storageProvider,
    );

    return shipments.map((shipment) => {
      const agentId = shipment.agent_id?.toString();
      const identity =
        agentId && agentIdentityVisibleAt(shipment.status) ? agentIdentities.get(agentId) : undefined;
      const displayName = identity ? toAgentDisplayName(identity.name) : null;

      return toCustomerShipmentDto(shipment, {
        agency: agencies.get(shipment.agency_id.toString()) ?? null,
        // A nameless agent yields no block at all rather than an empty one — a card
        // rendering a photo above a blank line is worse than no card.
        agent:
          identity && displayName
            ? {
              displayName,
              photo: (identity.avatarFileId && agentPhotos.get(identity.avatarFileId)) || null,
              visibleFrom: AGENT_IDENTITY_VISIBLE_FROM,
              verified: identity.verified,
            }
            : null,
      });
    });
  }

  /**
   * Maintain the first-class vendor↔customer relation + denormalized stats.
   * Secondary side-effect: never let a stats failure break the order flow.
   */
  private async syncVendorCustomerOrderPlaced(order: IOrder): Promise<void> {
    try {
      await this.vendorCustomerSync.recordOrderPlaced(
        order.vendor_id,
        order.customer_id,
        order.created_at
      );
    } catch (error) {
      console.error('[OrderService] Failed to sync vendor customer on order placed:', error);
    }
  }

  /**
   * Auto-dispatch a paid physical order to the agency in charge.
   *
   * Gated by the vendor's `auto_redirect_orders_to_agency` setting:
   * - OFF (default): no-op — shipments stay `pending` for manual dispatch.
   * - ON: advance the order's `pending` shipments to `assigned`, mirror the
   *   status onto each physical order item's `delivery`, and log a timeline
   *   event for the audit trail.
   *
   * The order's agency_id was already resolved at creation time, so this only
   * performs the hand-off — it never (re)selects an agency. Mutates `order`
   * in-memory; the caller persists it with `order.save()`. Best-effort: a
   * dispatch failure is logged but never breaks payment recording.
   */
  private async maybeDispatchToAgencies(order: IOrder): Promise<void> {
    try {
      const autoRedirect = await this.vendorSettingsRepo.getAutoRedirectOrdersToAgency(
        order.vendor_id.toString()
      );
      if (!autoRedirect) return;

      // Respect the vendor's optional max-order-total cap: orders above it stay
      // `pending` for manual dispatch even with auto-redirect on. null = no cap.
      const threshold = await this.vendorSettingsRepo.getAutoRedirectThresholdAmount(
        order.vendor_id.toString()
      );
      // Measured on the ITEMS (ADR-A11): the cap is the vendor's "how much of my goods may leave
      // without me looking", and a customer-paid delivery fee is not the vendor's goods. Before
      // ADR-A11 total_amount WAS the items, so this keeps the setting's meaning unchanged.
      const itemsValue = orderItemsGrossOf(order);
      if (threshold !== null && itemsValue > threshold) {
        console.log(
          `[OrderService] Order ${order._id} items ${itemsValue} exceed auto-redirect cap ${threshold}; left pending for manual dispatch.`
        );
        return;
      }

      // The COD-limit gate (owner decision 2026-10-02). Auto-redirect NEVER forces: a COD
      // shipment that would push its agency over the agency's own cash limit, or over the
      // vendor's `maxCashPerAgency`, is NOT dispatched — it stays `pending` with a
      // `cod_limit_hold` the vendor sees, and the rest of the order goes out. The order
      // itself was already accepted; only the hand-off waits.
      const pending = await this.shipmentRepo.findPendingByOrderId(order._id.toString());
      if (pending.length === 0) return; // Nothing pending (e.g. already dispatched)
      const verdicts = await this.evaluateCodHandoffs(order, pending, false);
      const held = verdicts.filter((v) => v.breach);
      for (const v of held) {
        await codLimitsService.markHeld(v.shipmentId, v.breach!);
      }
      const assignedShipments = await this.shipmentRepo.assignPendingByIds(
        order._id.toString(),
        verdicts.filter((v) => !v.breach).map((v) => v.shipmentId)
      );
      if (held.length > 0) {
        // Tell the vendor (notification `shipment.cod_limit_held`) — one event per held
        // shipment, post-hold, best-effort. Before 2026-10-02 the order screen was the only
        // place a hold showed, so a vendor who did not open it never learned the shipment
        // was sitting at `pending`.
        void this._publishCodLimitHeld(order, held)
          .catch((err) => console.error('[OrderService] shipment.cod_limit_held emit failed:', err));
        await this.timelineRepo.appendEvent({
          orderId: order._id.toString(),
          eventType: 'delivery.agency_updated',
          description: 'Auto-dispatch held back: the delivery agency is at its cash-on-delivery limit',
          metadata: {
            auto: true,
            codLimitHeld: held.map((v) => ({ shipmentId: v.shipmentId, agencyId: v.agencyId, ...v.breach })),
          },
          actorType: 'system',
          actorId: null
        });
      }
      if (assignedShipments.length === 0) return;

      // Mirror the hand-off onto the order items so vendor/customer views agree.
      this.mirrorDispatchOntoItems(order, assignedShipments);

      await this.timelineRepo.appendEvent({
        orderId: order._id.toString(),
        eventType: 'delivery.agency_updated',
        description: 'Order auto-dispatched to the delivery agency in charge',
        metadata: { auto: true, shipmentsAssigned: assignedShipments.length },
        actorType: 'system',
        actorId: null
      });

      await this._publishShipmentAssigned(assignedShipments, order);

      console.log(`[OrderService] Order ${order._id} auto-dispatched: ${assignedShipments.length} shipment(s) assigned.`);
    } catch (error) {
      console.error('[OrderService] Failed to auto-dispatch order to agency:', error);
    }
  }

  /**
   * Vendor-triggered manual dispatch: advance this order's `pending` shipments
   * to `assigned`, making them visible on the agency's dashboard
   * (`GET /agency/shipments` excludes `pending`). This is the explicit
   * review/approval gate — independent of the `auto_redirect_orders_to_agency`
   * setting, which does the same thing automatically on payment success for
   * vendors who opt in. Returns 0 (no-op) if nothing was pending, e.g. the
   * order was already dispatched or auto-redirect already handled it.
   *
   * `actor` is attributed on the timeline entry — 'vendor' for this manual
   * path, 'system' for the auto-redirect path (see maybeDispatchToAgencies).
   */
  async dispatchToAgency(
    orderId: string,
    actor: { type: 'vendor' | 'system' | 'admin'; id: string | null },
    opts: {
      force?: boolean;
      forcedBy?: { userId: string | null; role: string };
      /** Dispatch only these of the order's pending shipments (an admin agency push). */
      shipmentIds?: string[];
    } = {}
  ): Promise<number> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }
    if (order.order_type !== 'physical') {
      throw createAppError(ERROR_CODES.ORDER_WRONG_TYPE, 400, 'Only physical orders can be dispatched to a delivery agency');
    }
    // Prepaid orders dispatch only once paid. COD orders fulfil BEFORE payment
    // by design — dispatchable while the cash is still outstanding.
    const codAwaitingCash =
      order.payment_method === 'cash_on_delivery' &&
      (order.payment_status === 'AWAITING_PAYMENT' || order.payment_status === 'partially_paid');
    if (order.payment_status !== 'paid' && !codAwaitingCash) {
      throw createAppError(ERROR_CODES.ORDER_PAYMENT_REQUIRED, 422, undefined, { paymentStatus: order.payment_status });
    }
    if (order.dispute_hold?.active) {
      throw createAppError(ERROR_CODES.ORDER_DISPUTE_HOLD, 423, undefined, {
        disputeId: order.dispute_hold.gateway_dispute_id,
        reason: order.dispute_hold.reason,
      });
    }

    // The COD-limit gate (owner decision 2026-10-02) — the manual path REFUSES rather
    // than holds: 422 COD_AGENCY_LIMIT_EXCEEDED for the first shipment that would push its
    // agency over a limit, and nothing of the order is dispatched, unless `force`. A forced
    // shipment records who forced it. An ADMINISTRATOR's dispatch is not gated — the limit
    // protects the platform, and the administrator is the platform.
    const only = opts.shipmentIds ? new Set(opts.shipmentIds) : null;
    const pending = (await this.shipmentRepo.findPendingByOrderId(orderId))
      .filter((s) => !only || only.has((s._id as mongoose.Types.ObjectId).toString()));
    if (pending.length === 0) return 0;
    const verdicts: Array<{ shipmentId: string; breach: CodHandoffVerdict['breach'] }> = actor.type === 'admin'
      ? pending.map((s) => ({ shipmentId: (s._id as mongoose.Types.ObjectId).toString(), breach: null }))
      : await this.evaluateCodHandoffs(order, pending, opts.force === true);
    const refused = verdicts.find((v) => v.breach);
    if (refused && opts.force !== true) {
      throw codLimitsService.limitExceededError(refused as CodHandoffVerdict);
    }

    const assignedShipments = await this.shipmentRepo.assignPendingByIds(orderId, verdicts.map((v) => v.shipmentId));
    if (assignedShipments.length === 0) return 0;
    const assignedIds = new Set(assignedShipments.map((s) => (s._id as mongoose.Types.ObjectId).toString()));
    const forcedBreaches = new Map<string, NonNullable<CodHandoffVerdict['breach']>>();
    for (const v of verdicts) {
      if (v.breach && assignedIds.has(v.shipmentId)) {
        await codLimitsService.markForced(v.shipmentId, v.breach, opts.forcedBy ?? { userId: actor.id, role: actor.type });
        forcedBreaches.set(v.shipmentId, v.breach);
      }
    }

    this.mirrorDispatchOntoItems(order, assignedShipments);
    await order.save();

    await this.timelineRepo.appendEvent({
      orderId: order._id.toString(),
      eventType: 'delivery.agency_updated',
      description: DISPATCH_DESCRIPTION[actor.type],
      metadata: { auto: actor.type === 'system', shipmentsAssigned: assignedShipments.length },
      actorType: actor.type,
      actorId: actor.id,
    });

    // A FORCED shipment's `shipment.assigned` carries the breach, and the agency stack
    // renders it as `shipment.cod_limit.forced` instead — one notification per hand-off.
    await this._publishShipmentAssigned(assignedShipments, order, forcedBreaches);

    return assignedShipments.length;
  }

  /**
   * Judge each pending shipment against the COD limits (cod/domain/cod-limits.ts). A
   * prepaid order costs no query: every verdict is a pass.
   */
  private async evaluateCodHandoffs(order: IOrder, pending: IShipment[], force: boolean): Promise<CodHandoffVerdict[]> {
    const isCod = order.payment_method === 'cash_on_delivery';
    return codLimitsService.evaluateHandoffs(
      pending.map((s) => ({
        shipmentId: (s._id as mongoose.Types.ObjectId).toString(),
        agencyId: s.agency_id.toString(),
        vendorId: order.vendor_id.toString(),
        // The cash the agent will carry: goods + a customer-paid delivery fee (ADR-A11).
        amount: isCod ? expectedCodAmount(order.items as any[], s.items as any[], customerDeliveryFeeOf(order, s)) : 0,
      })),
      { force }
    );
  }

  /**
   * Mirror a dispatch onto the order items so vendor/customer views agree — only the items
   * riding a shipment that actually went out. An item with no `shipment_id` (legacy) follows
   * its agency's dispatched shipment.
   */
  private mirrorDispatchOntoItems(order: IOrder, assigned: IShipment[]): void {
    const shipmentIds = new Set(assigned.map((s) => (s._id as mongoose.Types.ObjectId).toString()));
    const agencyIds = new Set(assigned.map((s) => s.agency_id.toString()));
    for (const item of order.items) {
      if (!item.delivery || item.delivery.status !== 'pending') continue;
      const sid = item.delivery.shipment_id?.toString() ?? null;
      const rides = sid ? shipmentIds.has(sid) : agencyIds.has(item.delivery.agency_id?.toString() ?? '');
      if (rides) item.delivery.status = 'assigned';
    }
  }

  /**
   * Publish one `shipment.assigned` event per shipment just handed off to an
   * agency (dispatch, manual or auto). Each shipment belongs to exactly one
   * agency, so this is the natural per-recipient granularity — see
   * AgencyNotificationEventHandler.handleShipmentAssigned.
   */
  /**
   * `shipment.cod_limit_held` — one per shipment auto-redirect held back (vendor stack).
   * The agency's NAME rides the event; the figures are the breach's. Which of them the
   * vendor is shown is the catalogue's decision (`VENDOR_COD_HOLD_REASON`), not this one's.
   */
  private async _publishCodLimitHeld(order: IOrder, held: CodHandoffVerdict[]): Promise<void> {
    for (const v of held) {
      if (!v.breach) continue;
      const agencyName = await this.magazinRepo.findNameByAgencyId(v.agencyId);
      await eventBus.publish('shipment.cod_limit_held', {
        eventType: 'shipment.cod_limit_held',
        aggregateId: v.shipmentId,
        occurredAt: new Date(),
        payload: {
          shipmentId: v.shipmentId,
          orderId: order._id.toString(),
          orderNumber: order.order_number,
          vendorId: order.vendor_id.toString(),
          agencyId: v.agencyId,
          agencyName: agencyName ?? null,
          currency: order.currency ?? null,
          kind: v.breach.kind,
          currentExposure: v.breach.currentExposure,
          additionalAmount: v.breach.additionalAmount,
          limit: v.breach.limit,
        },
      });
    }
  }

  private async _publishShipmentAssigned(
    shipments: IShipment[],
    order: IOrder,
    forcedBreaches: Map<string, NonNullable<CodHandoffVerdict['breach']>> = new Map()
  ): Promise<void> {
    for (const shipment of shipments) {
      const shipmentId = (shipment._id as mongoose.Types.ObjectId).toString();
      const forced = forcedBreaches.get(shipmentId);
      await eventBus.publish('shipment.assigned', {
        eventType: 'shipment.assigned',
        aggregateId: shipmentId,
        payload: {
          shipmentId,
          agencyId: shipment.agency_id.toString(),
          orderId: order._id.toString(),
          orderNumber: order.order_number,
          itemCount: shipment.items.length,
          // Additive (2026-10-02): present only when the vendor pushed this shipment past a
          // COD limit with `force: true`. The agency stack switches situation on it.
          codLimitForce: forced
            ? {
                kind: forced.kind,
                amount: forced.additionalAmount,
                currency: order.currency ?? null,
                vendorId: order.vendor_id.toString(),
              }
            : null,
        },
        occurredAt: new Date(),
      });
    }
  }

  /**
   * Create orders from a customer's cart — ONE order per vendor.
   *
   * A single cart may hold items from multiple vendors (same product type). At
   * checkout we split it into one order per vendor, so each vendor owns exactly
   * one single-vendor order and its normal lifecycle (shipments, earnings split,
   * events, vendor-customer sync) runs untouched. Every order carries the source
   * cart's _id as `cart_id`, letting the customer view them as one logical order
   * while each vendor sees only their own order.
   *
   * ATOMICITY: all orders (and their shipments) are created in a single DB
   * transaction — a partial failure rolls everything back and leaves the cart intact.
   *
   * DEFENSE IN DEPTH: re-validates all cart business rules (no service products,
   * variant-first data, single currency, physical/digital only).
   *
   * @param customerId - Customer ID
   * @param paymentMethod - 'online' (default, prepaid via gateway) or
   *   'cash_on_delivery' (cash collected per shipment at handoff). Applies to
   *   the WHOLE checkout group — every order it splits into.
   * @param deliveryInput - The chosen drop-off address for a PHYSICAL checkout:
   *   an inline selected geocoding result (`address`) or the id of one of the
   *   customer's saved addresses (`addressId`). Resolved to a GeoAddress and
   *   snapshotted onto every physical order. Optional/back-compatible: when
   *   absent it falls back to the customer's default saved address's geo, and
   *   stays null if that too has none (legacy read-time derivation still works).
   * @returns The checkout-group cart id, created orders, and any shipments
   */
  async createOrdersFromCart(
    customerId: string,
    paymentMethod: OrderPaymentMethod = 'online',
    deliveryInput?: { addressId?: string | null; address?: GeoAddressInput | null } | null
  ): Promise<{ cartId: string; orders: IOrder[]; shipments: any[] }> {
    // 1. VALIDATION PHASE: Fetch and validate cart
    const cart = await this.cartService.getCart(customerId);

    if (!cart || cart.items.length === 0) {
      throw createAppError(ERROR_CODES.ORDER_CART_EMPTY, 400, 'Cannot create order from empty cart');
    }

    if (!cart.cartId) {
      throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'Cart is missing an identifier');
    }

    if (!cart.productType) {
      throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'Cart must have a product type');
    }

    // Defense in depth: scan for service products (should never happen)
    for (const item of cart.items) {
      if ((item.productType as string) === 'service') {
        throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'Service products cannot be ordered. They must be booked separately.');
      }
    }

    // Validate all items have required variant-first data
    for (const item of cart.items) {
      if (!item.variantId) {
        throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'All cart items must have a variant_id');
      }
      if (!item.sku) {
        throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'Cart item missing SKU');
      }
    }

    // Ensure all items have same currency
    const currencies = [...new Set(cart.items.map(item => item.currency))];
    if (currencies.length > 1) {
      throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, 'All cart items must have the same currency');
    }
    const currency = currencies[0];

    // Determine order type from cart
    const orderType: OrderType = cart.productType as OrderType;

    if (orderType !== 'physical' && orderType !== 'digital') {
      throw createAppError(ERROR_CODES.ORDER_CART_INVALID, 400, `Order type must be 'physical' or 'digital', got '${orderType}'`);
    }

    // COD is physical-only: nothing is handed over for digital goods, so there
    // is no moment to pay cash. Reject the whole checkout up front.
    if (paymentMethod === 'cash_on_delivery' && orderType !== 'physical') {
      throw createAppError(
        ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL,
        422,
        'Cash on delivery is only available for physical orders'
      );
    }

    // Resolve the drop-off (delivery) address for a PHYSICAL checkout and snapshot
    // it onto every order in the group. Digital orders have no delivery.
    const deliveryAddress = orderType === 'physical'
      ? await this.resolveDeliveryAddress(customerId, deliveryInput)
      : null;

    /**
     * A physical order MUST have somewhere to go.
     *
     * `resolveDeliveryAddress` falls through inline → named → default saved → **null**, and
     * until now nothing rejected the null: the order was created with
     * `delivery_address: null`, no drop-off, and the failure surfaced much later as a
     * shipment nobody could route.
     *
     * The subtle half is worse than the missing-address case. It returns `chosen.geo ?? null`,
     * and `geo` is only populated by the address picker (`GET /api/geo/search`) — so **an
     * address the customer explicitly selected still yields null if they typed it by hand**.
     * From the customer's side they chose an address and checkout succeeded; from the
     * agent's side there is no destination. Refusing here is what makes those two agree.
     *
     * `ORDER_DELIVERY_ADDRESS_REQUIRED` (422), not `ADDRESS_GEO_REQUIRED` (400): the
     * request here is well-formed — both address fields are optional — so this is a
     * business rule, not a schema failure. `details.reason` distinguishes the two causes so
     * the client can either open the address picker or ask the customer to re-select.
     */
    if (orderType === 'physical' && !deliveryAddress) {
      const hadSelection = Boolean(deliveryInput?.addressId || deliveryInput?.address);
      throw createAppError(
        ERROR_CODES.ORDER_DELIVERY_ADDRESS_REQUIRED,
        422,
        hadSelection
          ? 'The delivery address you selected has no geocoded location. Please re-select it from the address search so we can route your delivery.'
          : 'A delivery address is required for physical orders. Add one, or select a saved address that was chosen from the address search.',
        { reason: hadSelection ? 'selected_address_not_geocoded' : 'no_delivery_address' },
      );
    }

    // 2. GROUP CART ITEMS BY VENDOR — one order per vendor (this IS the
    //    single-vendor-per-order enforcement).
    const vendorGroups = new Map<string, CartResponse['items']>();
    for (const item of cart.items) {
      const group = vendorGroups.get(item.vendorId) ?? [];
      group.push(item);
      vendorGroups.set(item.vendorId, group);
    }

    // 3. CREATE ALL ORDERS ATOMICALLY (one per vendor).
    const { orders, shipments } = await transactionManager.runInTransaction(async (session) => {
      /**
       * Hold the stock FIRST, inside this transaction.
       *
       * Before anything reserved, `variant.stock` was a number a vendor typed in that the
       * order path never touched — overselling was unconstrained, and the unpaid-cancel
       * worker said so outright in its own comment.
       *
       * Two properties come from doing it here rather than after the orders exist:
       *
       *   - **All or nothing.** If the third line is out of stock, the first two must not
       *     stay held for an order that was never created. Sharing this session means the
       *     holds roll back with the orders.
       *   - **It fails before any order number is burned.** `CATALOG_INSUFFICIENT_STOCK`
       *     (422) reaches the customer as "that size just went", with the line named in
       *     `details`, rather than as an order they then cannot be given.
       *
       * The holds are *released* by cancellation or expiry and *committed* at payment
       * success — or, for COD, immediately below, since a COD order fulfils before payment.
       */
      await orderStockService.reserveForCheckout(
        cart.cartId!,
        cart.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          vendorId: item.vendorId,
          quantity: item.quantity,
        })),
        session,
      );

      const createdOrders: IOrder[] = [];
      const createdShipments: any[] = [];

      for (const [vendorId, items] of vendorGroups) {
        const built = await this.buildVendorOrder(
          { customerId, cartId: cart.cartId!, vendorId, items, orderType, currency, paymentMethod, deliveryAddress },
          session
        );
        createdOrders.push(built.order);
        createdShipments.push(...built.shipments);
      }

      // A cash-on-delivery order fulfils BEFORE payment — the vendor packs it and an agent
      // carries it out — so the units leave the shelf now, not when the cash arrives at the
      // door. Committed in the same transaction that created the order, because if the
      // order does not exist neither should the decrement.
      if (paymentMethod === 'cash_on_delivery') {
        for (const order of createdOrders) {
          await orderStockService.commitForOrder(order, session);
        }
      }

      return { orders: createdOrders, shipments: createdShipments };
    });

    // 4. POST-COMMIT SIDE EFFECTS: emit events + sync vendor↔customer, per order.
    //    Done after commit so a rollback never emits phantom events.
    for (const order of orders) {
      await this.emitOrderCreatedEvent(order);
      await this.syncVendorCustomerOrderPlaced(order);

      // COD orders have no payment-success moment before fulfilment, so the
      // vendor's auto-redirect (normally fired on payment success) runs at
      // checkout instead. Best-effort, same as the payment-success path.
      if (order.payment_method === 'cash_on_delivery' && order.order_type === 'physical') {
        await this.maybeDispatchToAgencies(order);
        try {
          await order.save();
        } catch (error) {
          console.error('[OrderService] Failed to persist COD auto-dispatch:', error);
        }
      }
    }

    // 5. Clear the cart once, after all orders are committed.
    await this.cartService.clearCart(customerId);

    return { cartId: cart.cartId, orders, shipments };
  }

  /**
   * Resolve the drop-off (delivery) GeoAddress for a physical checkout.
   *
   * Priority: an inline selected geocoding result → the geo of the named saved
   * address (`addressId`) → the geo of the customer's default saved address.
   * Returns null when none of these carry geo (a legacy saved address with no
   * geocoding), in which case the order stores no snapshot and read paths fall
   * back to deriving from the customer's current saved address. This keeps
   * checkout fully backward-compatible while making the drop-off durable and
   * geolocatable whenever the data exists.
   */
  private async resolveDeliveryAddress(
    customerId: string,
    deliveryInput?: { addressId?: string | null; address?: GeoAddressInput | null } | null
  ): Promise<IGeoAddress | null> {
    // An inline selected result always wins. Every branch pins the region to one of the
    // country's regions or refuses the checkout (ADDRESS_REGION_INVALID): this snapshot is
    // what agency coverage is matched against, and a region no contract can name leaves the
    // delivery with no agent. A saved address predating the rule is checked here too.
    if (deliveryInput?.address) {
      return toGeoAddress(canonicalizeAddressRegion(deliveryInput.address));
    }

    const customer = await CustomerModel.findById(customerId)
      .select('saved_addresses')
      .lean()
      .exec();
    const addresses = customer?.saved_addresses ?? [];

    if (deliveryInput?.addressId) {
      const chosen = addresses.find(a => a._id.toString() === deliveryInput.addressId);
      if (!chosen) {
        throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404, undefined, {
          addressId: deliveryInput.addressId,
        });
      }
      return chosen.geo ? canonicalizeAddressRegion(chosen.geo, { addressId: deliveryInput.addressId }) : null;
    }

    // No explicit selection — fall back to the customer's default saved address.
    const fallback = addresses.find(a => a.is_default) ?? addresses[0] ?? null;
    return fallback?.geo ? canonicalizeAddressRegion(fallback.geo, { addressId: fallback._id.toString() }) : null;
  }

  /**
   * Spend the negotiation locks on this vendor's lines, and return what each one
   * is actually worth — keyed by `variantId`, which is how a cart line is
   * addressed everywhere else here (cart items carry no `_id`).
   *
   * ── This is the ONLY re-resolution on the checkout path, and it is new ──────
   *
   * ⚠ `cart.service.ts` used to claim that "the price a cart quotes is
   * re-resolved at checkout, which is the moment that actually binds." **It was
   * not.** This method read `cartItem.price` — the snapshot taken when the line
   * entered the basket — and never called `PriceResolverService` at all; the only
   * other call site was `mergeCart`. That comment is corrected, and this is the
   * re-resolution D-12 requires.
   *
   * **Scoped to locked lines on purpose.** Re-resolving every line would change
   * ordinary checkout behaviour — a vendor's price edit would silently re-price a
   * basket somebody is in the middle of paying for — and that is a decision
   * nobody has taken. A locked line is different: its price MUST be re-checked,
   * because honouring an agreed price the vendor's current window no longer
   * contains would pay them below their own floor (D-10).
   *
   * Three properties are load-bearing:
   *
   *  - **It runs inside the order's transaction.** `consume` is a write, and a
   *    checkout that fails afterwards must leave the lock spendable — otherwise
   *    a customer whose payment page timed out has lost what they haggled for
   *    with nothing to show for it.
   *  - **It runs BEFORE the totals.** The consume verdict can legitimately carry
   *    a different price from the cart's snapshot, and `price_breakdown` must
   *    describe what is charged.
   *  - **A refusal throws, and takes the whole checkout with it.** All five
   *    `NEGOTIATION_LOCK_*` codes are client-safe, so the chat can say what
   *    happened and reopen the negotiation. Skipping the line and charging the
   *    list price instead would charge more than the customer agreed to.
   */
  private async resolveNegotiatedLines(
    customerId: string,
    items: CartResponse['items'],
    session: ClientSession,
  ): Promise<Map<string, { unitPrice: number; floorPrice: number }>> {
    const resolved = new Map<string, { unitPrice: number; floorPrice: number }>();

    for (const item of items) {
      if (!item.negotiationLockRef) continue;

      const price = await this.priceResolver.execute({
        productId: item.productId,
        variantId: item.variantId,
        vendorId: item.vendorId,
        quantity: item.quantity,
        negotiation: {
          lockRef: item.negotiationLockRef,
          customerId,
          mode: 'consume',
          session,
        },
      });

      // Defensive: `execute` returns `negotiated` whenever it was given a lock
      // and did not throw. If that ever stops being true, refuse rather than
      // silently record the line as un-negotiated — an un-negotiated line pays
      // the platform no AI margin and reports no floor, so the failure would be
      // a quiet accounting hole rather than an error.
      if (!price.negotiated) {
        throw createAppError(
          ERROR_CODES.NEGOTIATION_LOCK_INVALID,
          404,
          undefined,
          { variantId: item.variantId, lockRef: item.negotiationLockRef },
        );
      }

      resolved.set(item.variantId, {
        unitPrice: price.unitPrice,
        floorPrice: price.negotiated.floorPrice,
      });
    }

    return resolved;
  }

  /**
   * Build and persist ONE single-vendor order (plus its shipments, for physical
   * orders) within the given transaction session. Extracted from the cart split
   * so each vendor group produces an independent order that then runs the normal
   * vendor-side lifecycle.
   */
  private async buildVendorOrder(
    params: {
      customerId: string;
      cartId: string;
      vendorId: string;
      items: CartResponse['items'];
      orderType: OrderType;
      currency: string;
      paymentMethod: OrderPaymentMethod;
      deliveryAddress: IGeoAddress | null;
    },
    session: ClientSession
  ): Promise<{ order: IOrder; shipments: any[] }> {
    const { customerId, cartId, vendorId, items, orderType, currency, paymentMethod, deliveryAddress } = params;

    // Order number (unique per order)
    const orderNumber = await OrderNumberGenerator.generateOrderNumber();

    // Spend the negotiation locks and re-validate their prices, inside this
    // transaction, BEFORE anything is totalled — see `resolveNegotiatedLines`.
    const negotiatedLines = await this.resolveNegotiatedLines(customerId, items, session);

    // Statement facts (2026-09-27): what the storefront displayed for each variant, and who the
    // customer was at checkout. Read once per vendor order; neither changes a total.
    const [listPrices, bargainFloors, customerSnapshot] = await Promise.all([
      // Catalog answers "what did the shopper see" — orders must not read the bargain window
      // itself (test:bargain-price). See `display-price.lookup.ts`.
      displayPricesForVariants(items),
      // …and "what is the vendor's minimum", for a bargainable line with no lock: the bargain
      // fee is owed on anything above it, haggled or not (owner decision 2026-09-28).
      bargainFloorsForVariants(items),
      CustomerModel.findById(customerId).select('name phone').lean<{ name?: string; phone?: string | null } | null>(),
    ]);

    /**
     * Price breakdown from THIS vendor's items only.
     *
     * ⚠️ These figures are the ones `POST /api/customer/cart/quote` reports, and they must
     * stay that way — a quote that disagrees with the charge is worse than no quote.
     * `CartQuoteService` is the other half; read its header before changing any line here.
     *
     * **Delivery (ADR-A11, 2026-10-03).** `base` is the ITEMS. Who pays the agencies' fees is
     * decided below per vendor order from the shop's delivery terms (and the ADR-A07 cap's
     * fallback, D-6) by `VendorOrderPricingService` — the SAME path the cart quote prices with.
     * A customer-paid part adds `price_breakdown.delivery` to the total; a vendor-paid part
     * adds 0 and `splitOrder` deducts the fee from the vendor's net instead. Never both: the
     * splits deduct only the vendor-BORNE part (`orders/domain/delivery-payer.ts`).
     *
     * `tax` and `discount` are pinned zeros rather than absent: there is no tax engine and
     * no coupon model (`price_breakdown.discount` is the field a coupon feature would fill).
     * Keeping the fields present and zero means the receipt shape does not change the day
     * either arrives.
     */
    const unitPriceOf = (item: CartResponse['items'][number]): number =>
      negotiatedLines.get(item.variantId)?.unitPrice ?? item.price;

    const base = items.reduce((sum, item) => sum + (unitPriceOf(item) * item.quantity), 0);
    const tax = 0;       // No tax engine — see the note above.
    const discount = 0;  // No coupon model — see the note above.

    // Order items (snapshot from cart)
    const orderItemsPayload: any[] = items.map(cartItem => ({
      // Variant data (first-class) - from cart snapshot
      variant_id: new mongoose.Types.ObjectId(cartItem.variantId),
      sku: cartItem.sku,
      variant_title: cartItem.variantTitle,
      options_snapshot: cartItem.optionsSnapshot,

      // Product data (context) - from cart snapshot
      product_id: new mongoose.Types.ObjectId(cartItem.productId),
      title: cartItem.title,
      vendor_id: new mongoose.Types.ObjectId(cartItem.vendorId),
      product_type: cartItem.productType,

      // Pricing - from cart snapshot, EXCEPT on a line whose lock was just
      // consumed: there the verdict wins, because the vendor may have moved
      // their window since the cart was filled (D-10).
      quantity: cartItem.quantity,
      price: unitPriceOf(cartItem),
      currency: cartItem.currency,
      negotiated_unit_price: negotiatedLines.get(cartItem.variantId)?.unitPrice ?? null,
      // The floor the bargain fee is measured from. A negotiated line keeps its verdict's
      // floor; any other line of a bargainable variant takes the vendor's minimum now. Null
      // only on a variant that is not bargainable — the one case with no fee at all.
      floor_price_snapshot:
        negotiatedLines.get(cartItem.variantId)?.floorPrice ?? bargainFloors.get(cartItem.variantId) ?? null,
      list_price_snapshot: listPrices.get(cartItem.variantId) ?? null,

      // Delivery: added for physical orders below
    }));

    const shipments: any[] = [];

    if (orderType === 'physical') {
      /**
       * Resolve every line's delivery facts — the carrying agency (product override → the
       * vendor's default), the pickup SNAPSHOT, the pickup's region and the per-unit weight —
       * through the pricing path the cart quote uses too (`VendorOrderPricingService`, strict:
       * an unresolvable product / vendor / agency throws the checkout's own codes).
       */
      const facts = await vendorOrderPricingService.resolveDeliveryLines(
        items.map((i) => ({ productId: i.productId, variantId: i.variantId, vendorId: i.vendorId, title: i.title })),
        'strict',
      );

      // GROUP BY DELIVERY AGENCY (within this vendor's items)
      const agencyGroups: Record<string, any[]> = {};
      const pricingLines: PricingLine[] = [];

      for (let i = 0; i < items.length; i++) {
        const orderItem = orderItemsPayload[i];
        const fact = facts[i]!; // strict mode never yields null
        const agencyId = fact.agencyId!;

        // The per-unit weight the delivery fee is priced on (ADR-A11 D-4), snapshotted so the
        // split and any later re-pricing read what the customer was quoted, not today's catalog.
        orderItem.weight_grams = fact.weight.grams;
        orderItem.weight_source = fact.weight.source;

        // Add delivery info to order item
        orderItem.delivery = {
          agency_id: new mongoose.Types.ObjectId(agencyId),
          shipment_id: null,
          status: 'pending',
          pickup_location: fact.pickupLocation,
        };

        // Group by agency
        if (!agencyGroups[agencyId]) {
          agencyGroups[agencyId] = [];
        }
        agencyGroups[agencyId].push({ orderItem, index: i });

        pricingLines.push({
          unitPrice: orderItem.price,
          quantity: orderItem.quantity,
          floorPrice: orderItem.floor_price_snapshot ?? null,
          agencyId,
          pickupSource: fact.pickupLocation?.source ?? null,
          pickupRegion: fact.pickupRegion,
          unitWeightGrams: fact.weight.grams,
        });
      }

      /**
       * WHO PAYS DELIVERY, AND HOW MUCH (ADR-A11) — `priceVendorOrder`, the function the cart
       * quote reports. Inside the transaction on purpose: a refusal rolls back the stock holds
       * and the negotiation-lock consumption above.
       *
       *  - One fee per shipment (= agency), from THE formula: weight × qty, out-of-region
       *    against the drop-off, the agency's ceiling.
       *  - The shop's terms decide the payer; a VENDOR-paid part runs the ADR-A07 cap (online
       *    per order, COD per shipment) and FALLS BACK to customer-paid when it fails (D-6) —
       *    it no longer refuses.
       *  - The one refusal left is `ORDER_BELOW_DELIVERY_MINIMUM` when even customer-paid
       *    delivery leaves the vendor ≤ 0 (commission + bargain fee + the COD fee, D-5).
       */
      const pricing = await vendorOrderPricingService.price(
        {
          vendorId,
          paymentMethod,
          deliveryRegion: regionOfGeo(deliveryAddress),
          lines: pricingLines,
        },
        'strict',
      );
      if (pricing.deliveryMinimum && !pricing.deliveryMinimum.met) {
        throw belowMinimumError({ vendorId, ...pricing.deliveryMinimum }, currency);
      }

      const delivery = pricing.deliveryCharged;
      const total = base + delivery + tax - discount;
      const priceBreakdown = { base, delivery, tax, discount, total };

      // COD eligibility: every agency carrying one of this order's shipments must support COD
      // (its agent collects that shipment's cash) — measured on the order total INCLUDING
      // customer-paid delivery, which is cash the agent carries too. Validated inside the
      // checkout transaction so a failure rolls back the whole group.
      if (paymentMethod === 'cash_on_delivery') {
        await codEligibilityService.assertVendorOrderEligible({
          orderType,
          totalAmount: total,
          agencyIds: Object.keys(agencyGroups),
          vendorId,
        });
      }

      // CREATE ORDER (Physical)
      const order = await this.orderRepo.create({
        order_number: orderNumber,
        order_type: orderType,
        cart_id: new mongoose.Types.ObjectId(cartId),
        customer_id: customerId as any,
        vendor_id: new mongoose.Types.ObjectId(vendorId),
        items: orderItemsPayload as any,
        currency,
        price_breakdown: priceBreakdown,
        total_amount: total,
        delivery_payer: pricing.payer,
        delivery_payer_reason: pricing.payerReason,
        free_delivery_shortfall: pricing.freeDeliveryShortfall,
        payment_method: paymentMethod,
        payment_status: 'AWAITING_PAYMENT',  // Ready for payment (COD: paid at handoff)
        fulfillment_status: 'pending',
        delivery_address: deliveryAddress,  // Geocoded drop-off snapshot (null on legacy)
        customer_snapshot: customerSnapshot
          ? { name: customerSnapshot.name ?? null, phone: customerSnapshot.phone ?? null }
          : null,
      }, session);

      const pricedByAgency = new Map(pricing.shipments.map((s) => [s.agencyId, s]));

      // CREATE SHIPMENTS & UPDATE ORDER ITEMS
      for (const [agencyId, groupItems] of Object.entries(agencyGroups)) {
        const shipmentItems = groupItems.map(({ index }) => {
          const savedItem = order.items[index];
          return {
            order_item_id: savedItem._id,
            product_id: savedItem.product_id,
            // The sellable unit, denormalised so a delivered shipment can say
            // which variant left the shelf without joining back to the order.
            variant_id: savedItem.variant_id,
            quantity: savedItem.quantity
          };
        });

        // The posted price, snapshotted AT CHECKOUT for every physical shipment (ADR-A11):
        // what the agency will be paid, and — on a customer-paid order — what the customer was
        // charged for this run. The splits divide exactly these numbers.
        const priced = pricedByAgency.get(agencyId)!;
        const shipment = await this.shipmentRepo.create({
          order_id: order._id as any,
          agency_id: agencyId as any,
          status: 'pending',
          items: shipmentItems,
          delivery_payer: pricing.payer,
          delivery_fee_snapshot: priced.fee,
          customer_delivery_fee: pricing.payer === 'customer' ? priced.fee : 0,
          fee_components: {
            pickup_base: priced.components?.pickupBase ?? 0,
            weight_extra: priced.components?.weightExtra ?? 0,
            region_surcharge: priced.components?.regionSurcharge ?? 0,
            storage: priced.components?.storage ?? 0,
            cap_applied: priced.components?.capApplied ?? false,
            kg: priced.components?.kg ?? 1,
            weight_grams: priced.weightGrams,
            out_of_region: priced.outOfRegion,
            flat_fallback: priced.components === null,
          },
        }, session);

        shipments.push(shipment);

        // Update order items with shipment_id
        for (const { index } of groupItems) {
          const itemToUpdate = order.items[index];
          if (itemToUpdate.delivery) {
            itemToUpdate.delivery.shipment_id = shipment._id as any;
          }
        }
      }

      await order.save({ session });

      return { order, shipments };
    }

    // DIGITAL ORDER: No delivery, no shipments (COD rejected upstream)
    const total = base + tax - discount;
    const priceBreakdown = { base, delivery: 0, tax, discount, total };
    const order = await this.orderRepo.create({
      order_number: orderNumber,
      order_type: orderType,
      cart_id: new mongoose.Types.ObjectId(cartId),
      customer_id: customerId as any,
      vendor_id: new mongoose.Types.ObjectId(vendorId),
      items: orderItemsPayload as any,
      currency,
      price_breakdown: priceBreakdown,
      total_amount: total,
      payment_method: paymentMethod,
      payment_status: 'AWAITING_PAYMENT',  // Ready for payment
      fulfillment_status: 'pending',
      customer_snapshot: customerSnapshot
        ? { name: customerSnapshot.name ?? null, phone: customerSnapshot.phone ?? null }
        : null
    }, session);

    return { order, shipments: [] };
  }

  /**
   * Handle payment success webhook
   * 
   * IDEMPOTENT: Safe to call multiple times with same orderId
   * - Checks if already paid, returns early if so
   * - Branches fulfillment by order_type
   * - Updates payment and fulfillment status atomically
   * 
   * @param orderId - Order ID
   */
  async handlePaymentSuccess(orderId: string): Promise<void> {
    const order = await this.orderRepo.findById(orderId);

    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    // IDEMPOTENCY CHECK
    if (order.payment_status === 'paid') {
      console.log(`[OrderService] Order ${orderId} already paid. Skipping duplicate payment processing.`);
      return; // No-op, already processed
    }

    // Update payment status
    order.payment_status = 'paid';

    /**
     * The sale is real — take the units off the shelf.
     *
     * This is the prepaid half of the pair; a cash-on-delivery order commits at creation
     * instead (it fulfils before payment). Guarded by the idempotency check above, which
     * matters because payment webhooks are re-delivered: without that early return, a
     * replay would decrement twice.
     *
     * Best-effort and deliberately not awaited into a failure — see `commitForOrder`. The
     * money has already moved by the time this runs, so throwing would report an error for
     * a payment that succeeded. A missed commit leaves a hold that expires on its own.
     */
    await orderStockService.commitForOrder(order);

    // Branch fulfillment by order type
    if (order.order_type === 'physical') {
      // Physical: Mark as processing (delivery will handle fulfillment)
      order.fulfillment_status = 'processing';

      console.log(`[OrderService] Physical order ${orderId} paid. Fulfillment delegated to delivery system.`);

      // Auto-dispatch to the agency in charge when the vendor has opted in.
      // Otherwise shipments stay `pending` for the vendor to dispatch manually.
      await this.maybeDispatchToAgencies(order);

    } else if (order.order_type === 'digital') {
      // Digital: Grant entitlements via the shared fulfillment helper.
      // It loads each variant's digitalConfig (assetId, maxDownloads, expiresAfterDays)
      // and snapshots them onto the entitlement at grant time.
      order.fulfillment_status = 'processing';

      console.log(`[OrderService] Digital order ${orderId} paid. Granting entitlements...`);

      const { handleDigitalProductFulfillment } = await import('./digital-fulfillment.integration');

      const fulfilment = await handleDigitalProductFulfillment(
        order._id.toString(),
        order.items.map(item => ({
          _id: item._id.toString(),
          productId: item.product_id.toString(),
          variantId: item.variant_id.toString(),
          quantity: item.quantity,
        })),
        order.customer_id.toString(),
      );

      /**
       * 'fulfilled' means the customer can download what they paid for — nothing less.
       *
       * This used to be an unconditional assignment sitting after a call whose return was
       * discarded, so an order that granted ZERO entitlements was still stamped fulfilled.
       * That is what happened to ORD-2026-000052: paid, fulfilled, nothing to download, and
       * no signal anywhere. See the ⚠ on `handleDigitalProductFulfillment`.
       *
       * Leaving it at 'processing' on failure is the deliberate choice, and it is load-bearing
       * in two places rather than cosmetic: `OrderCompletionService.isSettled` treats a digital
       * order as settled iff it is 'fulfilled', and the earnings release worker only matures
       * escrow for 'fulfilled' / 'delivered' / 'partially_delivered'. So a failed grant now
       * holds the vendor's payout instead of paying out for an undelivered file, and the order
       * stays visibly stuck rather than silently done. Re-running fulfilment is safe — the
       * grant is idempotent on (orderId, orderItemId).
       */
      if (fulfilment.failed.length > 0) {
        console.error(
          `[OrderService] Digital order ${orderId} is NOT fulfilled — ${fulfilment.failed.length} of ` +
          `${fulfilment.failed.length + fulfilment.granted.length} item(s) granted no entitlement. ` +
          `Left at 'processing'. Reasons:`,
          fulfilment.failed,
        );
      } else {
        order.fulfillment_status = 'fulfilled';
      }
    }

    await order.save();

    // Refresh product/variant inactivity clocks so the file-cleanup sweep never
    // detaches media from a product that just sold. Non-critical: log on failure.
    await this.markProductsOrdered(order);

    // Split the paid amount into held earnings (vendor net, platform commission,
    // agency delivery fee). Idempotent and best-effort: a failure here must not
    // fail webhook processing — the daily sweep / a webhook retry will recover.
    try {
      await earningsSplitService.splitOrder(order);
    } catch (error) {
      console.error('[OrderService] Failed to split earnings on payment success:', error);
    }

    // Add the paid total to the customer's denormalized lifetime spend.
    try {
      await this.vendorCustomerSync.recordPaymentPaid(
        order.vendor_id,
        order.customer_id,
        order.total_amount
      );
    } catch (error) {
      console.error('[OrderService] Failed to sync vendor customer on payment success:', error);
    }

    console.log(`[OrderService] Order ${orderId} payment success handled. Payment: ${order.payment_status}, Fulfillment: ${order.fulfillment_status}`);
  }

  /**
   * Stamp `lastOrderedAt = now` on every product/variant in a freshly-paid
   * order. This is the activity signal the file-cleanup inactivity clock reads,
   * so a product that sells today is never swept for media detachment.
   *
   * Best-effort: a failure here must not fail payment processing.
   */
  private async markProductsOrdered(order: IOrder): Promise<void> {
    try {
      const now = new Date();

      // ⚠ `OrderRepository.findById` does `.populate('items.product_id')`, so on
      // that path `product_id` is a DOCUMENT, not an id — and `.toString()` on a
      // Mongoose document yields its inspected form, which `new ObjectId(...)`
      // then rejects with a BSONError. The catch below swallowed it, so this
      // method threw on every paid order and `lastOrderedAt` was never stamped
      // on anything. That field is the inactivity clock the file-cleanup sweep
      // reads, so the products that sell were the ones most at risk of having
      // their media detached.
      //
      // Reading through the populate rather than removing it: the populate has
      // other consumers, and a method that must survive both shapes is the
      // honest fix.
      const idOf = (ref: unknown): mongoose.Types.ObjectId | null => {
        const raw = ref && typeof ref === 'object' && '_id' in ref ? (ref as { _id: unknown })._id : ref;
        if (raw instanceof mongoose.Types.ObjectId) return raw;
        if (typeof raw === 'string' && mongoose.Types.ObjectId.isValid(raw)) {
          return new mongoose.Types.ObjectId(raw);
        }
        return null;
      };

      const collect = (pick: (item: IOrder['items'][number]) => unknown): mongoose.Types.ObjectId[] => {
        const seen = new Map<string, mongoose.Types.ObjectId>();
        for (const item of order.items) {
          const id = idOf(pick(item));
          if (id) seen.set(id.toString(), id);
        }
        return [...seen.values()];
      };

      const productIds = collect((i) => i.product_id);
      const variantIds = collect((i) => i.variant_id);

      await Promise.all([
        ProductModel.updateMany({ _id: { $in: productIds } }, { $set: { lastOrderedAt: now } }),
        ProductVariantModel.updateMany({ _id: { $in: variantIds } }, { $set: { lastOrderedAt: now } }),
      ]);
    } catch (error) {
      console.error('[OrderService] Failed to update lastOrderedAt:', error);
    }
  }

  /**
   * Emit order.created event
   *
   * Called after order is successfully created to notify vendors.
   *
   * @param order - Created order
   */
  private async emitOrderCreatedEvent(order: IOrder): Promise<void> {
    try {
      await eventBus.publish('order.created', {
        eventType: 'order.created',
        aggregateId: order._id.toString(),
        occurredAt: new Date(),
        payload: {
          orderId: order._id.toString(),
          vendorId: order.vendor_id.toString(),
          customerId: order.customer_id.toString(),
          orderNumber: order.order_number,
          orderType: order.order_type,
          totalAmount: order.total_amount,
          currency: order.currency,
          itemCount: order.items.length,
          // Units, not lines: two packs of one product are ONE line and TWO units. The customer's
          // "order placed" said "1 item(s)" for two packs (owner's handset, 2026-09-22). Additive —
          // `itemCount` keeps its meaning for every existing consumer.
          unitCount: order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
        }
      });

      console.log(`[OrderService] Emitted order.created event for order ${order._id}`);
    } catch (error: any) {
      console.error('[OrderService] Failed to emit order.created event:', error);
      // Don't throw - this is a secondary operation
    }
  }
}
