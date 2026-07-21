import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { GeoAddressZodSchema } from '../../core/types/geo-address.types';
import { OrderModel } from './order.model';
import { OrderCompletionService, orderCompletionService } from './order-completion.service';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { VendorRepository } from '../vendors/vendor.repository';
import { assertCancellationAllowed } from '../vendors/utils/cancellation-policy.util';
import { ShipmentService } from '../shipments/shipment.service';
import { ShipmentModel } from '../shipments/shipment.model';
import { cashCollectionService } from '../cod/services/cash-collection.service';

const completionService: OrderCompletionService = orderCompletionService;
const orderService = new OrderService();
const orderRepository = new OrderRepository();
const vendorRepository = new VendorRepository();
const shipmentService = new ShipmentService();

/**
 * Collapse a checkout group's per-order payment statuses into one label the
 * customer UI can show for the logical "order": all paid → paid; any paid or
 * partially collected (COD) → partially_paid; none paid → awaiting_payment.
 */
function aggregatePaymentStatus(statuses: string[]): string {
  if (statuses.every(s => s === 'paid')) return 'paid';
  if (statuses.some(s => s === 'paid' || s === 'partially_paid')) return 'partially_paid';
  if (statuses.every(s => s === 'AWAITING_PAYMENT' || s === 'pending')) return 'awaiting_payment';
  return 'mixed';
}

/** Fulfillment states from which a customer may still cancel (pre-shipment). */
const CANCELLABLE_FULFILLMENT_STATES = ['pending', 'processing'];

/**
 * Shipment statuses past which a COD order is no longer customer-cancellable:
 * the package left the agency (or already reached the customer), so the
 * failed-delivery flow owns the outcome from here.
 */
const COD_NON_CANCELLABLE_SHIPMENT_STATUSES = [
  'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned',
];

const CheckoutSchema = z
  .object({
    paymentMethod: z.enum(['online', 'cash_on_delivery']).optional().default('online'),
    // Drop-off address for a physical checkout. Provide EITHER the id of one of
    // the customer's saved addresses OR a selected geocoding result inline. Both
    // optional (back-compat): when neither is given the order falls back to the
    // customer's default saved address. Snapshotted onto every order in the group.
    deliveryAddressId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, 'deliveryAddressId must be a valid id')
      .optional(),
    deliveryAddress: GeoAddressZodSchema.optional(),
  })
  .refine(d => !(d.deliveryAddressId && d.deliveryAddress), {
    message: 'Provide either deliveryAddressId or deliveryAddress, not both',
    path: ['deliveryAddress'],
  });

const CancelOrderSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * Customer-facing order actions.
 *
 * Currently exposes delivery confirmation: the customer confirms they received
 * the order (or are satisfied with a digital/service purchase), which completes
 * the order and starts the 7-day escrow hold before funds become withdrawable.
 */
export class CustomerOrderController {
  /**
   * POST /customer/orders/checkout
   *
   * Turn the customer's cart into orders — ONE order per vendor. A multi-vendor
   * cart yields several orders sharing a `cartId`; the customer then pays once
   * for the whole group via POST /payments/initiate with that cartId.
   */
  static checkout = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { paymentMethod, deliveryAddressId, deliveryAddress } = CheckoutSchema.parse(req.body ?? {});

    const { cartId, orders } = await orderService.createOrdersFromCart(customerId, paymentMethod, {
      addressId: deliveryAddressId ?? null,
      address: deliveryAddress ?? null,
    });

    res.status(201).json({
      success: true,
      data: {
        cartId,
        paymentMethod,
        orders: orders.map(order => ({
          id: order._id.toString(),
          orderNumber: order.order_number,
          vendorId: order.vendor_id.toString(),
          orderType: order.order_type,
          total: order.total_amount,
          currency: order.currency,
          paymentMethod: order.payment_method,
          paymentStatus: order.payment_status,
          fulfillmentStatus: order.fulfillment_status,
          itemCount: order.items.length,
        })),
      },
      message: paymentMethod === 'cash_on_delivery'
        ? 'Orders created. Pay the delivery agent in cash at handoff — you will receive a delivery code for each shipment.'
        : 'Orders created. Complete payment for the cart to proceed.',
    });
  });

  /**
   * GET /customer/orders
   *
   * The customer's order history, grouped by checkout group (cartId). Each group
   * is one logical order that may contain several per-vendor orders.
   */
  static listOrderGroups = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

    const { data, meta } = await orderRepository.findGroupsByCustomer(customerId, { page, limit });

    res.status(200).json({
      success: true,
      data: data.map(group => ({
        cartId: group.cartId,
        createdAt: group.createdAt,
        currency: group.currency,
        totalAmount: group.totalAmount,
        orderCount: group.orderCount,
        paymentStatus: aggregatePaymentStatus(group.paymentStatuses),
        orders: group.orders,
      })),
      meta,
    });
  });

  /**
   * GET /customer/orders/groups/:cartId
   *
   * One checkout group in detail (all its per-vendor orders with items).
   * Ownership enforced by scoping to the authenticated customer.
   */
  static getOrderGroup = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const cartId = req.params.cartId;

    const orders = await orderRepository.findByCartAndCustomer(cartId, customerId);
    if (orders.length === 0) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { cartId });
    }

    const totalAmount = orders.reduce((sum, o) => sum + o.total_amount, 0);

    // COD: per-shipment cash blocks, incl. the delivery code for still-pending
    // handoffs — this is the customer's own view, the code is their secret.
    const hasCod = orders.some(o => o.payment_method === 'cash_on_delivery');
    const codByOrder = hasCod
      ? await cashCollectionService.getCodBlocksForOrders(orders.map(o => o._id.toString()), true)
      : new Map<string, any[]>();

    res.status(200).json({
      success: true,
      data: {
        cartId,
        createdAt: orders[0].created_at,
        currency: orders[0].currency,
        totalAmount,
        orderCount: orders.length,
        paymentStatus: aggregatePaymentStatus(orders.map(o => o.payment_status)),
        orders: orders.map(order => ({
          id: order._id.toString(),
          orderNumber: order.order_number,
          vendorId: order.vendor_id.toString(),
          orderType: order.order_type,
          total: order.total_amount,
          currency: order.currency,
          paymentMethod: order.payment_method,
          paymentStatus: order.payment_status,
          fulfillmentStatus: order.fulfillment_status,
          codCollections: order.payment_method === 'cash_on_delivery'
            ? (codByOrder.get(order._id.toString()) ?? [])
            : undefined,
          items: order.items.map(item => ({
            id: item._id.toString(),
            productId: item.product_id.toString(),
            variantId: item.variant_id.toString(),
            sku: item.sku,
            title: item.title,
            variantTitle: item.variant_title,
            quantity: item.quantity,
            price: item.price,
            currency: item.currency,
            freeDelivery: item.delivery?.free_delivery ?? false,
          })),
        })),
      },
    });
  });

  /**
   * PATCH /customer/orders/:id/confirm-delivery
   *
   * Confirmable once fulfilment is `delivered` (physical) or `fulfilled`
   * (digital) and the order has not already been completed.
   */
  static confirmDelivery = asyncHandler(async (req: Request, res: Response) => {
    const orderId = req.params.id;
    const customerId = req.auth!.role_entity._id.toString();

    const order = await OrderModel.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    // Ownership: a customer may only confirm their own orders.
    if (order.customer_id.toString() !== customerId) {
      throw createAppError(ERROR_CODES.EARNINGS_FORBIDDEN, 403);
    }

    completionService.assertConfirmable(order);

    await completionService.complete(order, 'customer', false, req.auth!.user.id);

    res.status(200).json({
      success: true,
      data: {
        order_id: order._id.toString(),
        completed_at: order.completion.confirmed_at,
      },
    });
  });

  /**
   * POST /customer/orders/:orderId/shipments/:shipmentId/confirm-delivery
   *
   * Per-shipment delivery confirmation for multi-agency orders — confirmable
   * once THAT shipment (not necessarily the whole order) reaches
   * `agent_delivered`. Once every shipment of the order is confirmed, the
   * order's own `fulfillment_status` becomes 'delivered' and its `completion`
   * (escrow-release gate) fires automatically — no separate order-level click.
   */
  static confirmShipmentDelivery = asyncHandler(async (req: Request, res: Response) => {
    const { orderId, shipmentId } = req.params;
    const customerId = req.auth!.role_entity._id.toString();

    const result = await shipmentService.confirmDeliveryByCustomer(
      customerId,
      orderId,
      shipmentId,
      req.auth!.user.id
    );

    res.status(200).json({ success: true, data: result });
  });

  /**
   * POST /customer/orders/:orderId/shipments/:shipmentId/resend-delivery-code
   *
   * COD: regenerate this shipment's delivery code, resend it via WhatsApp and
   * return it (it is the customer's own secret). Wrong-attempt lockouts reset.
   */
  static resendDeliveryCode = asyncHandler(async (req: Request, res: Response) => {
    const { orderId, shipmentId } = req.params;
    const customerId = req.auth!.role_entity._id.toString();

    const result = await cashCollectionService.resendCodeAsCustomer(customerId, orderId, shipmentId);

    res.status(200).json({
      success: true,
      data: result,
      message: 'A new delivery code was generated. Give it to the agent only after you have received and paid for your package.',
    });
  });

  /**
   * POST /customer/orders/:id/cancel
   *
   * Customer-initiated cancellation, gated by the vendor's cancellation policy.
   * Limited to pre-shipment orders (`pending`/`processing`). Unpaid orders are
   * cancelled directly; PAID orders are rejected with guidance to use the refund
   * flow (this endpoint is eligibility-only and performs no refund).
   */
  static cancelOrder = asyncHandler(async (req: Request, res: Response) => {
    const orderId = req.params.id;
    const customerId = req.auth!.role_entity._id.toString();
    const { reason } = CancelOrderSchema.parse(req.body ?? {});

    const order = await OrderModel.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    // Ownership: a customer may only cancel their own orders.
    if (order.customer_id.toString() !== customerId) {
      throw createAppError(ERROR_CODES.EARNINGS_FORBIDDEN, 403);
    }

    if (order.fulfillment_status === 'cancelled') {
      throw createAppError(ERROR_CODES.ORDER_ALREADY_CANCELLED, 409);
    }
    if (!CANCELLABLE_FULFILLMENT_STATES.includes(order.fulfillment_status)) {
      throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
        fulfillmentStatus: order.fulfillment_status,
      });
    }

    // Enforce the vendor's cancellation policy. Orders have no firm delivery
    // date, so delivery-based deadlines fall back to creation-based handling.
    const vendor = await vendorRepository.findById(order.vendor_id.toString());
    assertCancellationAllowed(vendor?.policies?.cancellation_policy ?? null, {
      createdAt: order.created_at,
      isPending: order.fulfillment_status === 'pending',
    });

    // Paid orders require a refund — out of scope for this eligibility-only path.
    if (order.payment_status === 'paid') {
      throw createAppError(ERROR_CODES.ORDER_CANCEL_REQUIRES_REFUND, 422);
    }
    // Only unpaid orders can be cancelled here; anything else is non-cancellable.
    if (order.payment_status !== 'pending' && order.payment_status !== 'AWAITING_PAYMENT') {
      throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
        paymentStatus: order.payment_status,
      });
    }

    // COD orders fulfil before payment, so "unpaid" alone isn't enough: once
    // any package left the agency (picked_up onwards) the handoff/failed-
    // delivery flow owns the outcome — no silent cancellation underneath it.
    if (order.payment_method === 'cash_on_delivery' && order.order_type === 'physical') {
      const inFlight = await ShipmentModel.countDocuments({
        order_id: orderId,
        status: { $in: COD_NON_CANCELLABLE_SHIPMENT_STATUSES },
      });
      if (inFlight > 0) {
        throw createAppError(ERROR_CODES.ORDER_NOT_CANCELLABLE, 422, undefined, {
          reason: 'A shipment is already out for delivery or has been handled',
        });
      }
    }

    await orderService.cancelOrder(order, {
      actorType: 'customer',
      actorId: customerId,
      reason: reason ?? 'Cancelled by customer',
    });

    res.status(200).json({
      success: true,
      data: { order_id: order._id.toString(), fulfillment_status: order.fulfillment_status },
      message: 'Order cancelled',
    });
  });
}
