import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess, sendPaginated } from '../../core/responses';
import { OrderModel } from './order.model';
import { paymentDisputeService } from '../payments/services/dispute.service';

const ResolveDisputeSchema = z.object({
  outcome: z.enum(['won', 'lost']),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Admin order-dispute controls. Lets an admin see orders frozen by a payment
 * dispute and manually resolve them (override) when a Stripe event is missed or
 * the case is handled out of band.
 *
 * Path: /api/admin/orders
 */
export class AdminOrderController {
  /** List orders currently held by a payment dispute (newest first). */
  static listDisputed = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = ListQuerySchema.parse(req.query);
    const filter = {
      $or: [{ 'dispute_hold.active': true }, { payment_status: 'disputed' }],
    };

    const [data, total] = await Promise.all([
      OrderModel.find(filter)
        .sort({ updated_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      OrderModel.countDocuments(filter),
    ]);

    sendPaginated(res, data, { total, page, limit, pages: Math.ceil(total / limit) });
  });

  /**
   * Manually resolve an order's dispute. `won` lifts the hold and restores
   * `paid`; `lost` refunds + returns/cancels and reverses escrow.
   */
  static resolveDispute = asyncHandler(async (req: Request, res: Response) => {
    const { outcome } = ResolveDisputeSchema.parse(req.body);
    const orderId = req.params.id;

    const order = await OrderModel.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }

    await paymentDisputeService.adminResolveOrder(orderId, outcome);

    const updated = await OrderModel.findById(orderId);
    sendSuccess(res, updated, { message: `Dispute resolved as ${outcome}` });
  });
}
