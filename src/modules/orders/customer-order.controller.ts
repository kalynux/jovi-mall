import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { OrderModel } from './order.model';
import { OrderCompletionService, orderCompletionService } from './order-completion.service';

const completionService: OrderCompletionService = orderCompletionService;

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
}
