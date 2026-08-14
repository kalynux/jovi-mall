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
import { ShipmentService } from '../shipments/shipment.service';
import { cashCollectionService } from '../cod/services/cash-collection.service';
import { customerOrderViewService } from './services/customer-order-view.service';

const completionService: OrderCompletionService = orderCompletionService;
const orderService = new OrderService();
const orderRepository = new OrderRepository();
const vendorRepository = new VendorRepository();
const shipmentService = new ShipmentService();

/**
 * Collapse a checkout group's per-order payment statuses into one label the
 * customer UI can show for the logical "order": all paid → paid; any paid or
 * partially collected (COD) → partially_paid; none paid → awaiting_payment.
 *
 * ⚠️ **The empty case is checked first, and that is a fix rather than defensiveness.**
 * `[].every(...)` is `true` in JavaScript, so an empty group used to report `'paid'` — the
 * most reassuring possible answer to "what happened to my money" derived from no data at
 * all. A group with no orders is `'unknown'`, which is at least honest.
 *
 * The other correction is `failed` / `refunded` / `disputed`: they previously fell through
 * to `'mixed'`, so a fully refunded group read as "mixed" and a customer looking for their
 * refund saw a word that means nothing. They now get their own labels.
 */
function aggregatePaymentStatus(statuses: string[]): string {
  if (statuses.length === 0) return 'unknown';
  if (statuses.every(s => s === 'refunded')) return 'refunded';
  if (statuses.every(s => s === 'failed')) return 'failed';
  if (statuses.some(s => s === 'disputed')) return 'disputed';
  if (statuses.every(s => s === 'paid')) return 'paid';
  if (statuses.some(s => s === 'paid' || s === 'partially_paid')) return 'partially_paid';
  if (statuses.every(s => s === 'AWAITING_PAYMENT' || s === 'pending')) return 'awaiting_payment';
  return 'mixed';
}

// `CANCELLABLE_FULFILLMENT_STATES` and `COD_NON_CANCELLABLE_SHIPMENT_STATUSES` moved to
// `order.service.ts` alongside `assertCancellable`, which now owns the whole guard
// sequence. They were module-private here, which made them uncopyable by the second actor
// that needs them — an administrator cancelling through `/api/internal/admin/orders`.

/**
 * `GET /customer/orders` — pagination plus the filters the history screen needs.
 *
 * The endpoint accepted `page` and `limit` and nothing else, so a customer with a year of
 * orders had no way to find one: no status filter, no date range, no search.
 *
 * `status` and `paymentStatus` are typed against the model's own enums rather than left as
 * free strings — an unknown value is a `400` naming the field, instead of a silent empty
 * page that looks like "you have no orders". Note `payment_status` carries two spellings for
 * the unpaid state (`pending` and `AWAITING_PAYMENT`); both are accepted because both exist
 * in the data.
 */
const CustomerOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      'pending', 'processing', 'partially_shipped', 'shipped',
      'partially_delivered', 'delivered', 'fulfilled', 'cancelled', 'returned',
    ])
    .optional(),
  paymentStatus: z
    .enum(['pending', 'AWAITING_PAYMENT', 'partially_paid', 'paid', 'disputed', 'failed', 'refunded'])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

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
    // Parsed by a schema rather than by hand-rolled `parseInt` fallbacks: the filters below
    // reach a `$match`, so a malformed value must be a 400 with a named field rather than
    // being silently coerced into something that quietly returns the wrong rows.
    const query = CustomerOrderListQuerySchema.parse(req.query);

    const { data, meta } = await orderRepository.findGroupsByCustomer(
      customerId,
      { page: query.page, limit: query.limit },
      {
        fulfillmentStatus: query.status,
        paymentStatus: query.paymentStatus,
        from: query.from,
        to: query.to,
        q: query.q,
      },
    );

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

    // One projection for both this and GET /:id — see customer-order.dto.ts. Store
    // identity, thumbnails and COD blocks are all batched across the whole group.
    const dtos = await customerOrderViewService.toDtos(orders);

    res.status(200).json({
      success: true,
      data: {
        cartId,
        createdAt: orders[0].created_at,
        currency: orders[0].currency,
        totalAmount,
        orderCount: orders.length,
        paymentStatus: aggregatePaymentStatus(orders.map(o => o.payment_status)),
        orders: dtos,
      },
    });
  });

  /**
   * GET /customer/orders/:id
   *
   * One per-vendor order in detail.
   *
   * Before this the only per-order read was `GET /groups/:cartId`, which returns the whole
   * checkout group — so a customer holding a single `orderId` (from a push deep link, an
   * email, or the `orderId` every notification carries) had no endpoint to open it with.
   * They had to already know the `cartId`, which nothing had told them.
   *
   * Same body as one element of the group's `orders[]`, built by the same projection.
   */
  static getOrder = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const orderId = req.params.id;

    // Ownership is the query, not a check after it: a mismatch is indistinguishable from a
    // nonexistent order, so the endpoint cannot confirm whether an id is real.
    const order = await OrderModel.findOne({ _id: orderId, customer_id: customerId });
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    const [dto] = await customerOrderViewService.toDtos([order]);
    res.status(200).json({ success: true, data: dto });
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
   * GET /customer/orders/:orderId/shipments
   *
   * Where the customer's parcels are — and the endpoint that makes the two below
   * **reachable at all**. Both need a `:shipmentId`, and until now no customer-facing
   * response returned one except inside `codCollections`, which is undefined for every
   * online-paid order. A prepaid customer therefore had no way to confirm a delivery.
   *
   * Statuses are collapsed to the five-word customer vocabulary and the agent's identity
   * and the internal failure notes are never included — see `customer-shipment.dto.ts`.
   */
  static listOrderShipments = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const shipments = await orderService.listShipmentsForCustomer(customerId, req.params.orderId);
    res.status(200).json({ success: true, data: shipments });
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

    // Every cancellation guard lives on the service, so the administrator's cancel path
    // enforces the same six rules from the same code. The vendor's cancellation policy is
    // the one the customer answers to and an administrator does not — hence `actorType`.
    const vendor = await vendorRepository.findById(order.vendor_id.toString());
    await orderService.assertCancellable(order, {
      actorType: 'customer',
      vendorPolicy: vendor?.policies?.cancellation_policy ?? null,
    });

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
