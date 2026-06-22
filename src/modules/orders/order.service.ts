import mongoose from 'mongoose';
import { IOrder, OrderType } from './order.model';
import { OrderRepository } from './order.repository';
import { CartService } from '../cart/services/cart.service';
import { ShipmentRepository } from '../shipments/shipment.repository';
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

      const assignedCount = await this.shipmentRepo.assignPendingByOrderId(order._id.toString());
      if (assignedCount === 0) return; // Nothing pending (e.g. already dispatched)

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
        metadata: { auto: true, shipmentsAssigned: assignedCount },
        actorType: 'system',
        actorId: null
      });

      console.log(`[OrderService] Order ${order._id} auto-dispatched: ${assignedCount} shipment(s) assigned.`);
    } catch (error) {
      console.error('[OrderService] Failed to auto-dispatch order to agency:', error);
    }
  }

  /**
   * Create order from customer's cart
   *
   * DEFENSE IN DEPTH:
   * - Re-validates all cart business rules
   * - Ensures no service products
   * - Snapshots all variant + product data from cart
   * - Branches by order_type (physical vs digital)
   * 
   * @param customerId - Customer ID
   * @param paymentIntentId - Optional payment provider reference
   * @returns Created order and shipments (if physical)
   */
  async createOrderFromCart(
    customerId: string,
    paymentIntentId?: string
  ): Promise<{ order: IOrder; shipments: any[] }> {
    // 1. VALIDATION PHASE: Fetch and validate cart
    const cart = await this.cartService.getCart(customerId);

    if (!cart || cart.items.length === 0) {
      throw createAppError(ERROR_CODES.ORDER_CART_EMPTY, 400, 'Cannot create order from empty cart');
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

    // 2. GENERATE ORDER NUMBER
    const orderNumber = await OrderNumberGenerator.generateOrderNumber();

    // 3. CALCULATE PRICE BREAKDOWN
    const base = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const tax = 0;       // TODO: Implement tax calculation
    const discount = 0;  // TODO: Implement discount calculation
    const total = base + tax - discount;

    const priceBreakdown = {
      base,
      tax,
      discount,
      total
    };

    // 4. CREATE ORDER ITEMS (snapshot from cart)
    const orderItemsPayload: any[] = cart.items.map(cartItem => ({
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

      // Delivery: will be added for physical orders below
    }));

    // 5. BRANCHING LOGIC: Physical vs Digital
    const shipments: any[] = [];

    if (orderType === 'physical') {
      // GROUP BY DELIVERY AGENCY (for physical products)
      const agencyGroups: Record<string, any[]> = {};
      const vendorCache: Record<string, IVendor> = {};

      for (let i = 0; i < cart.items.length; i++) {
        const cartItem = cart.items[i];
        const orderItem = orderItemsPayload[i];

        // Fetch product to get delivery agency
        const product: any = await this.productRepo.findByIdUnscoped(cartItem.productId);

        if (!product) {
          throw createAppError(ERROR_CODES.ORDER_PRODUCT_NOT_FOUND, 404, undefined, { productId: cartItem.productId });
        }

        let agencyId = product.delivery?.agencyId?.toString();

        // Fallback to vendor default delivery agency
        if (!agencyId) {
          const vendorId = cartItem.vendorId;
          let vendor = vendorCache[vendorId];

          if (!vendor) {
            const v = await this.vendorRepo.findById(vendorId);
            if (!v) {
              throw createAppError(ERROR_CODES.ORDER_VENDOR_NOT_FOUND, 404, undefined, { vendorId });
            }
            vendor = v;
            vendorCache[vendorId] = vendor;
          }

          agencyId = vendor.default_delivery_agency_id?.toString();
        }

        if (!agencyId) {
          throw createAppError(ERROR_CODES.ORDER_NO_DELIVERY_AGENCY, 422, undefined, { product: cartItem.title });
        }

        // Add delivery info to order item
        orderItem.delivery = {
          agency_id: new mongoose.Types.ObjectId(agencyId),
          shipment_id: null,
          status: 'pending'
        };

        // Group by agency
        if (!agencyGroups[agencyId]) {
          agencyGroups[agencyId] = [];
        }
        agencyGroups[agencyId].push({ orderItem, index: i });
      }

      // CREATE ORDER (Physical)
      const order = await this.orderRepo.create({
        order_number: orderNumber,
        order_type: orderType,
        customer_id: customerId as any,
        vendor_id: new mongoose.Types.ObjectId(cart.items[0].vendorId),  // Layer 2: Order Service validation
        items: orderItemsPayload as any,
        currency,
        price_breakdown: priceBreakdown,
        total_amount: total,
        payment_status: 'AWAITING_PAYMENT',  // Ready for payment
        payment_intent_id: paymentIntentId,
        fulfillment_status: 'pending'
      });

      // CREATE SHIPMENTS & UPDATE ORDER ITEMS
      for (const [agencyId, groupItems] of Object.entries(agencyGroups)) {
        const shipmentItems = groupItems.map(({ orderItem, index }) => {
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
        });

        shipments.push(shipment);

        // Update order items with shipment_id
        for (const { index } of groupItems) {
          const itemToUpdate = order.items[index];
          if (itemToUpdate.delivery) {
            itemToUpdate.delivery.shipment_id = shipment._id as any;
          }
        }
      }

      await order.save();

      // Emit order.created event
      await this.emitOrderCreatedEvent(order);

      // Record/refresh the vendor↔customer relation + stats
      await this.syncVendorCustomerOrderPlaced(order);

      // Clear cart after successful order creation
      await this.cartService.clearCart(customerId);

      return { order, shipments };

    } else {
      // DIGITAL ORDER: No delivery, no shipments
      const order = await this.orderRepo.create({
        order_number: orderNumber,
        order_type: orderType,
        customer_id: customerId as any,
        vendor_id: new mongoose.Types.ObjectId(cart.items[0].vendorId),  // Layer 2: Order Service validation
        items: orderItemsPayload as any,
        currency,
        price_breakdown: priceBreakdown,
        total_amount: total,
        payment_status: 'AWAITING_PAYMENT',  // Ready for payment
        payment_intent_id: paymentIntentId,
        fulfillment_status: 'pending'
      });

      // Emit order.created event
      await this.emitOrderCreatedEvent(order);

      // Record/refresh the vendor↔customer relation + stats
      await this.syncVendorCustomerOrderPlaced(order);

      // Clear cart after successful order creation
      await this.cartService.clearCart(customerId);

      return { order, shipments: [] };
    }
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
