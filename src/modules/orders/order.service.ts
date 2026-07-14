import mongoose, { ClientSession } from 'mongoose';
import { IOrder, OrderType, OrderPaymentMethod } from './order.model';
import { OrderRepository } from './order.repository';
import { CartService, CartResponse } from '../cart/services/cart.service';
import { transactionManager } from '../../core/database/transaction.manager';
import { ShipmentRepository } from '../shipments/shipment.repository';
import { IShipment } from '../shipments/shipment.model';
import { OrderTimelineRepository } from './order-timeline.repository';
import { VendorRepository } from '../vendors/vendor.repository';
import { VendorSettingsRepository } from '../vendors/repositories/vendor-settings.repository';
import { IVendor } from '../vendors/vendor.model';
import { OrderNumberGenerator } from './utils/order-number-generator';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { ProductRepositoryMongo } from '../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../catalog/repositories/mongo/variant.repository.mongo';
import { ProductModel } from '../catalog/models/product.model';
import { ProductVariantModel } from '../catalog/models/product-variant.model';
import { VendorCustomerSyncService } from '../vendors/services/vendor-customer-sync.service';
import { eventBus } from '../../core/events/event-bus';
import { earningsSplitService } from '../earnings/services/earnings-split.service';
import { codEligibilityService } from '../cod/services/cod-eligibility.service';

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
  async cancelOrder(
    order: IOrder,
    opts: { actorType: 'system' | 'customer' | 'vendor'; actorId: string | null; reason?: string }
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
      if (threshold !== null && order.total_amount > threshold) {
        console.log(
          `[OrderService] Order ${order._id} total ${order.total_amount} exceeds auto-redirect cap ${threshold}; left pending for manual dispatch.`
        );
        return;
      }

      const assignedShipments = await this.shipmentRepo.assignPendingByOrderId(order._id.toString());
      if (assignedShipments.length === 0) return; // Nothing pending (e.g. already dispatched)

      // Mirror the hand-off onto the order items so vendor/customer views agree.
      for (const item of order.items) {
        if (item.delivery && item.delivery.status === 'pending') {
          item.delivery.status = 'assigned';
        }
      }

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
  async dispatchToAgency(orderId: string, actor: { type: 'vendor' | 'system'; id: string | null }): Promise<number> {
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

    const assignedShipments = await this.shipmentRepo.assignPendingByOrderId(orderId);
    if (assignedShipments.length === 0) return 0;

    for (const item of order.items) {
      if (item.delivery && item.delivery.status === 'pending') {
        item.delivery.status = 'assigned';
      }
    }
    await order.save();

    await this.timelineRepo.appendEvent({
      orderId: order._id.toString(),
      eventType: 'delivery.agency_updated',
      description: actor.type === 'vendor'
        ? 'Vendor dispatched the order to its delivery agency'
        : 'Order auto-dispatched to the delivery agency in charge',
      metadata: { auto: actor.type === 'system', shipmentsAssigned: assignedShipments.length },
      actorType: actor.type,
      actorId: actor.id,
    });

    await this._publishShipmentAssigned(assignedShipments, order);

    return assignedShipments.length;
  }

  /**
   * Publish one `shipment.assigned` event per shipment just handed off to an
   * agency (dispatch, manual or auto). Each shipment belongs to exactly one
   * agency, so this is the natural per-recipient granularity — see
   * AgencyNotificationEventHandler.handleShipmentAssigned.
   */
  private async _publishShipmentAssigned(shipments: IShipment[], order: IOrder): Promise<void> {
    for (const shipment of shipments) {
      await eventBus.publish('shipment.assigned', {
        eventType: 'shipment.assigned',
        aggregateId: (shipment._id as mongoose.Types.ObjectId).toString(),
        payload: {
          shipmentId: (shipment._id as mongoose.Types.ObjectId).toString(),
          agencyId: shipment.agency_id.toString(),
          orderId: order._id.toString(),
          orderNumber: order.order_number,
          itemCount: shipment.items.length,
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
   * @returns The checkout-group cart id, created orders, and any shipments
   */
  async createOrdersFromCart(
    customerId: string,
    paymentMethod: OrderPaymentMethod = 'online'
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
      const createdOrders: IOrder[] = [];
      const createdShipments: any[] = [];

      for (const [vendorId, items] of vendorGroups) {
        const built = await this.buildVendorOrder(
          { customerId, cartId: cart.cartId!, vendorId, items, orderType, currency, paymentMethod },
          session
        );
        createdOrders.push(built.order);
        createdShipments.push(...built.shipments);
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
    },
    session: ClientSession
  ): Promise<{ order: IOrder; shipments: any[] }> {
    const { customerId, cartId, vendorId, items, orderType, currency, paymentMethod } = params;

    // Order number (unique per order)
    const orderNumber = await OrderNumberGenerator.generateOrderNumber();

    // Price breakdown from THIS vendor's items only
    const base = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const tax = 0;       // TODO: Implement tax calculation
    const discount = 0;  // TODO: Implement discount calculation
    const total = base + tax - discount;
    const priceBreakdown = { base, tax, discount, total };

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

      // Pricing - from cart snapshot
      quantity: cartItem.quantity,
      price: cartItem.price,
      currency: cartItem.currency,

      // Delivery: added for physical orders below
    }));

    const shipments: any[] = [];

    if (orderType === 'physical') {
      // GROUP BY DELIVERY AGENCY (within this vendor's items)
      const agencyGroups: Record<string, any[]> = {};
      const vendorCache: Record<string, IVendor> = {};

      for (let i = 0; i < items.length; i++) {
        const cartItem = items[i];
        const orderItem = orderItemsPayload[i];

        // Fetch product to get delivery agency
        const product: any = await this.productRepo.findByIdUnscoped(cartItem.productId);

        if (!product) {
          throw createAppError(ERROR_CODES.ORDER_PRODUCT_NOT_FOUND, 404, undefined, { productId: cartItem.productId });
        }

        let agencyId = product.delivery?.agencyId?.toString();
        const freeDelivery = product.delivery?.freeDelivery ?? false;

        // Vendor is needed either for the default-agency fallback or to resolve
        // the pickup-location address snapshot below — always fetch/cache it.
        let vendor = vendorCache[cartItem.vendorId];
        if (!vendor) {
          const v = await this.vendorRepo.findById(cartItem.vendorId);
          if (!v) {
            throw createAppError(ERROR_CODES.ORDER_VENDOR_NOT_FOUND, 404, undefined, { vendorId: cartItem.vendorId });
          }
          vendor = v;
          vendorCache[cartItem.vendorId] = vendor;
        }

        // Fallback to vendor default delivery agency
        if (!agencyId) {
          agencyId = vendor.default_delivery_agency_id?.toString();
        }

        if (!agencyId) {
          throw createAppError(ERROR_CODES.ORDER_NO_DELIVERY_AGENCY, 422, undefined, { product: cartItem.title });
        }

        // Snapshot the product's configured pickup location so a later edit to
        // the vendor's business addresses doesn't retroactively change history
        // (see ProductStatusValidationService for how this was validated/required
        // at activation time). Left null only for pre-feature products that
        // somehow reached 'active' without one — order creation isn't the place
        // to re-run the full activation gate.
        const pickupLocation = product.delivery?.pickupLocation;
        let pickupLocationSnapshot: any = null;
        if (pickupLocation?.source === 'agency_storage') {
          pickupLocationSnapshot = { source: 'agency_storage', vendor_address_id: null, address_snapshot: null };
        } else if (pickupLocation?.source === 'vendor_address' && pickupLocation.vendorAddressId) {
          const address = vendor.business_addresses?.find(
            (a: any) => a._id.toString() === pickupLocation.vendorAddressId,
          );
          if (address) {
            pickupLocationSnapshot = {
              source: 'vendor_address',
              vendor_address_id: new mongoose.Types.ObjectId(pickupLocation.vendorAddressId),
              address_snapshot: {
                label: address.label,
                address_line1: address.address_line1,
                address_line2: address.address_line2 ?? null,
                city: address.city,
                state: address.state ?? null,
              },
            };
          }
        }

        // Add delivery info to order item
        orderItem.delivery = {
          agency_id: new mongoose.Types.ObjectId(agencyId),
          shipment_id: null,
          status: 'pending',
          free_delivery: freeDelivery,
          pickup_location: pickupLocationSnapshot
        };

        // Group by agency
        if (!agencyGroups[agencyId]) {
          agencyGroups[agencyId] = [];
        }
        agencyGroups[agencyId].push({ orderItem, index: i });
      }

      // COD eligibility: every agency carrying one of this order's shipments
      // must support COD (its agent collects that shipment's cash). Validated
      // inside the checkout transaction so a failure rolls back the whole group.
      if (paymentMethod === 'cash_on_delivery') {
        await codEligibilityService.assertVendorOrderEligible({
          orderType,
          totalAmount: total,
          agencyIds: Object.keys(agencyGroups),
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
        payment_method: paymentMethod,
        payment_status: 'AWAITING_PAYMENT',  // Ready for payment (COD: paid at handoff)
        fulfillment_status: 'pending'
      }, session);

      // CREATE SHIPMENTS & UPDATE ORDER ITEMS
      for (const [agencyId, groupItems] of Object.entries(agencyGroups)) {
        const shipmentItems = groupItems.map(({ index }) => {
          const savedItem = order.items[index];
          return {
            order_item_id: savedItem._id,
            product_id: savedItem.product_id,
            quantity: savedItem.quantity
          };
        });

        const shipment = await this.shipmentRepo.create({
          order_id: order._id as any,
          agency_id: agencyId as any,
          status: 'pending',
          items: shipmentItems
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
      fulfillment_status: 'pending'
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

      await handleDigitalProductFulfillment(
        order._id.toString(),
        order.items.map(item => ({
          _id: item._id.toString(),
          productId: item.product_id.toString(),
          variantId: item.variant_id.toString(),
          quantity: item.quantity,
        })),
        order.customer_id.toString(),
      );

      order.fulfillment_status = 'fulfilled';
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
      const productIds = [...new Set(order.items.map((i) => i.product_id.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));
      const variantIds = [...new Set(order.items.map((i) => i.variant_id.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));

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
          itemCount: order.items.length
        }
      });

      console.log(`[OrderService] Emitted order.created event for order ${order._id}`);
    } catch (error: any) {
      console.error('[OrderService] Failed to emit order.created event:', error);
      // Don't throw - this is a secondary operation
    }
  }
}
