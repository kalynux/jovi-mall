import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { OrderModel } from './order.model';
import { OrderCompletionService, orderCompletionService } from './order-completion.service';
import { OrderService } from './order.service';
import { VendorRepository } from '../vendors/vendor.repository';
import { assertCancellationAllowed } from '../vendors/utils/cancellation-policy.util';

const completionService: OrderCompletionService = orderCompletionService;
const orderService = new OrderService();
const vendorRepository = new VendorRepository();

/** Fulfillment states from which a customer may still cancel (pre-shipment). */
const CANCELLABLE_FULFILLMENT_STATES = ['pending', 'processing'];

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
