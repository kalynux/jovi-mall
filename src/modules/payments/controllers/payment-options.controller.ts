import { Request, Response, RequestHandler } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { PaymentOptionsService } from '../services/payment-options.service';

/**
 * `GET /api/payments/options` (ADR-A08). No authentication: a checkout screen asks before
 * anybody has signed in, and the answer names nothing private.
 *
 * `Cache-Control: no-store` because a stale list is how a client offers a provider that has
 * since dropped out. The server keeps its own 5-second copy (`PaymentOptionsService`); a
 * client keeps none.
 *
 * Standard `{ success, data }` envelope, unlike the four flat payment routes beside it.
 */
export function createPaymentOptionsHandler(service: PaymentOptionsService): RequestHandler {
  return asyncHandler(async (_req: Request, res: Response) => {
    const data = service.get();
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data });
  });
}
