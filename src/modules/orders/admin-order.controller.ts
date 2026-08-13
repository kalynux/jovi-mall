import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess, sendPaginated } from '../../core/responses';
import { adminCallerActor } from '../../api/middlewares/admin-caller.middleware';
import { OrderModel } from './order.model';
import { OrderService } from './order.service';
import { adminRefundService } from './admin-refund.service';
import { paymentDisputeService } from '../payments/services/dispute.service';

const orderService = new OrderService();

const ResolveDisputeSchema = z.object({
  outcome: z.enum(['won', 'lost']),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const CancelOrderSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

const DispatchOrderSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).default({});

const RefundOrderSchema = z.object({
  /** Absent means the full remaining refundable balance — see AdminRefundService. */
  amount: z.number().positive().optional(),
  reason: z.string().trim().min(3).max(500),
  /** Acknowledges going beyond the vendor's commercial policy. Never a money override. */
  overridePolicy: z.boolean().optional(),
});

/**
 * Administrative order controls.
 *
 * ── Two mounts, two audiences ─────────────────────────────────────────────────
 * `listDisputed` and `resolveDispute` serve BOTH `/api/admin/orders` (the legacy
 * dashboard, alive until cutover) and `/api/internal/admin/orders` (wi-admin). The other
 * four are internal-only — see `admin-order.routes.ts` for why.
 *
 * ── Every write here is a thin scoping wrapper ────────────────────────────────
 * No business rule is decided in this file. `assertCancellable`, the dispatch guards, the
 * refund's money invariants and the dispute unwinding all live in their domain services,
 * which the agency, vendor and customer paths call too. An administrator is a THIRD ACTOR
 * on those services, never a parallel implementation of them — so a rule added there
 * applies here by construction rather than by somebody remembering.
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
   *
   * A resolution that changed nothing is a **409**, not a 200. The service is idempotent
   * because a Stripe webhook retries and a replay must be harmless; an operator is not a
   * webhook, and "Dispute resolved as won" for an order that was never disputed is a lie
   * a support ticket gets closed on.
   */
  static resolveDispute = asyncHandler(async (req: Request, res: Response) => {
    const { outcome } = ResolveDisputeSchema.parse(req.body);
    const orderId = req.params.orderId;

    const order = await OrderModel.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    }

    const actor = adminCallerActor(req);
    const resolution = await paymentDisputeService.adminResolveOrder(orderId, outcome, {
      type: actor ? 'admin' : 'system',
      id: actor?.id ?? null,
    });

    if (resolution === 'noop') {
      throw createAppError(
        ERROR_CODES.ORDER_DISPUTE_NOT_ACTIVE,
        409,
        'This order has no dispute to resolve.',
        { orderId, paymentStatus: order.payment_status }
      );
    }

    const updated = await OrderModel.findById(orderId);
    sendSuccess(res, updated, { message: `Dispute resolved as ${outcome}` });
  });

  /**
   * Cancel an order.
   *
   * The six guards are `OrderService.assertCancellable`'s, shared verbatim with the
   * customer's own cancel endpoint. The single difference is `actorType: 'admin'`, which
   * skips the VENDOR's cancellation policy — a return window is the vendor's commercial
   * promise to their customer and the platform is not party to it. Every other guard
   * (the fulfilment window, paid-requires-a-refund, a COD parcel already in a van) binds
   * an administrator exactly as it binds a customer.
   */
  static cancel = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = CancelOrderSchema.parse(req.body ?? {});
    const orderId = req.params.orderId;

    const order = await OrderModel.findById(orderId);
    if (!order) {
      throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
    }

    await orderService.assertCancellable(order, { actorType: 'admin', vendorPolicy: null });

    const actor = adminCallerActor(req);
    await orderService.cancelOrder(order, {
      actorType: 'admin',
      actorId: actor?.id ?? null,
      reason,
    });

    const updated = await OrderModel.findById(orderId);
    sendSuccess(res, updated, { message: 'Order cancelled' });
  });

  /**
   * Dispatch a paid-but-undispatched order to its delivery agency.
   *
   * The unblock for an order the vendor never dispatched and auto-redirect never picked
   * up. Every guard is `dispatchToAgency`'s own — physical-only, paid or COD-awaiting-cash,
   * and 423 on a dispute hold. Returns `shipmentsAssigned: 0` when there was nothing
   * pending: a no-op, not an error, because the usual cause is that it dispatched a moment
   * ago.
   */
  static dispatch = asyncHandler(async (req: Request, res: Response) => {
    DispatchOrderSchema.parse(req.body ?? {});
    const orderId = req.params.orderId;
    const actor = adminCallerActor(req);

    const shipmentsAssigned = await orderService.dispatchToAgency(orderId, {
      type: 'admin',
      id: actor?.id ?? null,
    });

    const updated = await OrderModel.findById(orderId);
    sendSuccess(
      res,
      { order: updated, shipmentsAssigned },
      {
        message: shipmentsAssigned > 0
          ? `Dispatched ${shipmentsAssigned} shipment(s) to the delivery agency`
          : 'Nothing to dispatch — no shipment on this order was pending',
      }
    );
  });

  /**
   * What may be refunded, and what it would cost the vendor's policy.
   *
   * Gated on `orders.refund` rather than `orders.read` in wi-admin: the answer is a
   * ceiling on money leaving the platform, not a record.
   */
  static refundEligibility = asyncHandler(async (req: Request, res: Response) => {
    const eligibility = await adminRefundService.getEligibility(req.params.orderId);
    sendSuccess(res, eligibility);
  });

  /**
   * Refund an order on the platform's authority.
   *
   * `overridePolicy` waives the VENDOR's commercial terms — the return window, the refund
   * percentage — and nothing else. Every money invariant (the remaining refundable
   * balance, the gateway's capability, the pending-row-before-the-gateway-call pipeline)
   * is the orchestrator's and holds regardless.
   */
  static refund = asyncHandler(async (req: Request, res: Response) => {
    const input = RefundOrderSchema.parse(req.body ?? {});
    const actor = adminCallerActor(req);

    const result = await adminRefundService.refund(req.params.orderId, input, {
      id: actor?.id ?? '',
      name: actor?.name ?? null,
    });

    sendSuccess(res, result, {
      message: result.withinVendorPolicy
        ? 'Refund completed'
        : 'Refund completed — the vendor’s return policy was overridden',
    });
  });

}
