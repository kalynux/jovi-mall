import { Request, RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { actorFromRequest } from '../../core/types/actor-source.types';
import { deliveryFeeRefundAdminService } from './services/delivery-fee-refund-admin.service';
import {
  DeliveryFeeRefundParamsSchema,
  ListManualDeliveryFeeRefundsQuerySchema,
  SettleDeliveryFeeRefundSchema,
} from './validators/delivery-fee-proposal.validator';

/**
 * Manual delivery-fee refunds — `/api/internal/admin/delivery-fee-refunds` (ADR-A11 W-E2, owner
 * decision D-12). Internal only, behind `requireAdminCaller`; there has never been a public twin
 * and there must not be one.
 *
 * Delegated rather than written by wi-admin directly because settling is a transaction paired
 * with post-commit effects: the ledger row's compare-and-set (and, on a partial cover, the
 * remainder row), the admin audit row, then the ticket resolution and the customer's
 * `order.delivery_fee.refund_settled` notification. A second writer would move the row and tell
 * nobody. wi-admin may read `delivery_fee_refunds` directly; the two reads here exist so its
 * settle button needs no second read model.
 *
 * ⛔ Authorization is wi-admin's (`X-Actor-Tier` is advisory and never read here). Who settled is
 * stamped from the caller headers (`actorFromRequest`), never from the body.
 */
const Controller = {
  /** GET / — the manual refunds. Query: status? (manual_required|settled|all), orderId?, page?, limit? */
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = ListManualDeliveryFeeRefundsQuerySchema.parse(req.query);
    const result = await deliveryFeeRefundAdminService.list(query);
    sendSuccess(res, result.data, { meta: result.meta });
  }),

  /** GET /:refundId — one manual refund (404 for an automatic one). */
  getById: asyncHandler(async (req: Request, res: Response) => {
    const { refundId } = DeliveryFeeRefundParamsSchema.parse(req.params);
    sendSuccess(res, await deliveryFeeRefundAdminService.getById(refundId));
  }),

  /**
   * POST /:refundId/settle — record that a person returned the money (or that a refund of the
   * whole order already had). Body: { method, reference?, note? }.
   */
  settle: asyncHandler(async (req: Request, res: Response) => {
    const { refundId } = DeliveryFeeRefundParamsSchema.parse(req.params);
    const body = SettleDeliveryFeeRefundSchema.parse(req.body);
    const result = await deliveryFeeRefundAdminService.settle(refundId, body, actorFromRequest(req));
    sendSuccess(res, result, {
      message: result.remainder ? 'Partly covered — the rest is still owed.' : 'Delivery-fee refund marked settled.',
    });
  }),
};

/** Build the manual delivery-fee refund surface behind an arbitrary guard chain. */
export function buildAdminDeliveryFeeRefundRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  router.get('/', Controller.list);
  router.get('/:refundId', Controller.getById);
  router.post('/:refundId/settle', Controller.settle);
  return router;
}
