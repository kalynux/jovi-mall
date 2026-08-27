import { Router, Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { payLinkService } from '../services/pay-link.service';
import { InitiatePaymentSchema, VerifyPaymentSchema, AuthorizePaymentSchema } from '../validators/payment.validators';

const router = Router();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * POST /payments/initiate
 *
 * Initiate payment. Provide EITHER:
 *  - `cartId`  → one payment for a whole checkout group (multi-vendor cart split
 *                into N per-vendor orders); settlement fans out to every order, OR
 *  - `orderId` → a single-order payment (legacy path).
 *
 * IDEMPOTENT: Multiple calls return the existing transaction.
 *
 * REQUEST:
 * {
 *   cartId?: string,   // preferred for cart checkout
 *   orderId?: string,  // single-order payment
 *   gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE',
 *   channel: {
 *     phoneNumber?: string,
 *     phoneOperator?: 'MTN' | 'ORANGE' | 'MOOV',
 *     cardToken?: string,
 *     customerEmail?: string,
 *     customerName?: string
 *   }
 * }
 *
 * RESPONSE:
 * {
 *   success: boolean,
 *   transactionId: string,
 *   status: string,
 *   instructions?: { ussdCode?: string, clientSecret?: string, message?: string },
 *   message: string
 * }
 */
router.post('/initiate', asyncHandler(async (req: Request, res: Response) => {
  // The body used to be hand-checked key by key, which left `channel.phoneNumber`
  // and `channel.customerEmail` to reach the gateway exactly as typed. One schema
  // now covers the same rules plus the contact formats, and reports them in the
  // platform's standard validation-error shape.
  const { cartId, orderId, gateway, channel } = InitiatePaymentSchema.parse(req.body);

  const result = cartId
    ? await paymentOrchestrator.initiatePaymentForCart(cartId, gateway as PaymentGatewayType, channel)
    : await paymentOrchestrator.initiatePayment(orderId!, gateway as PaymentGatewayType, channel);

  res.status(200).json({ success: result.status !== 'FAILED', ...result });
}));

/**
 * POST /payments/verify
 * 
 * Verify payment status
 * 
 * IDEMPOTENT: Can be called multiple times
 * 
 * REQUEST:
 * {
 *   transactionId: string
 * }
 * 
 * RESPONSE:
 * {
 *   success: boolean,
 *   transactionId: string,
 *   status: string,
 *   message: string
 * }
 */
router.post('/verify', asyncHandler(async (req: Request, res: Response) => {
  const { transactionId } = VerifyPaymentSchema.parse(req.body);

  const result = await paymentOrchestrator.verifyPayment(transactionId);

  res.status(200).json({ success: result.status === 'SUCCEEDED', ...result });
}));

/**
 * POST /payments/:transactionId/authorize
 *
 * Submit the one-time code for a mobile-money charge whose `initiate` reported
 * `instructions.requiresOtp` — My-CoolPay's Orange Money flow. Without this
 * step that payment can never complete: the operator SMSes a code and takes no
 * money until it comes back.
 *
 * ── UNAUTHENTICATED, LIKE ITS TWO NEIGHBOURS ─────────────────────────────────
 * `initiate` and `verify` take no credentials by design — payment links are
 * shareable, and the person paying is often not the person who ordered (see
 * `api-doc/payments/README.md`). An authenticated authorize would break the
 * same flow those two exist to serve.
 *
 * What bounds it instead: Layer A's IP rate limit (this path is NOT under the
 * rate-limit-exempt `/api/webhooks` prefix), and a per-transaction attempt
 * counter enforced in the orchestrator. Exhausting the counter FAILS the
 * payment rather than throttling it — waiting does not make a wrong code right.
 *
 * RESPONSE:
 * {
 *   success: boolean,
 *   transactionId: string,
 *   status: string,
 *   instructions?: { ussdCode?: string, message?: string },
 *   message: string
 * }
 */
router.post('/:transactionId/authorize', asyncHandler(async (req: Request, res: Response) => {
  const { code } = AuthorizePaymentSchema.parse(req.body);

  const result = await paymentOrchestrator.authorizePayment(req.params.transactionId, code);

  res.status(200).json({ success: true, ...result });
}));

/**
 * GET /payments/session/:token
 *
 * The hosted card page's read (GAP-008). **Unauthenticated, by the same design that makes
 * `initiate`, `verify` and `authorize` unauthenticated** — a payment link is shareable and
 * the person paying is often not the person who ordered.
 *
 * ⚠ **This is deliberately NOT `GET /payments/:transactionId` opened up.** The note on that
 * route below is the reason: transaction ids are the only thing between one customer and
 * another's payment record, so an unauthenticated read on them is a record any caller can
 * walk by incrementing. This route takes a 256-bit handle that exists only on transactions
 * somebody deliberately minted a link for, expires, and is superseded by the next mint.
 *
 * The response is an explicit projection — never the transaction document. What it may and
 * may not carry, and when the client secret travels, is `domain/pay-link.ts`.
 *
 * ⚠ Declared ABOVE `GET /:transactionId`. Express would not confuse them (two segments
 * against one), but this service has been bitten by route order twice and the habit is
 * cheaper than the incident.
 *
 * ── MAINTENANCE ─────────────────────────────────────────────────────────────
 * A `GET`, so it survives a `readonly` window on the ordinary safe-method rule and needs no
 * exemption. It is blocked in `down`, correctly and with its neighbours: `initiate` and
 * `verify` are blocked too, so a payment cannot be started or confirmed in that window
 * either, and a page that loaded but could not settle would be worse than one that says the
 * platform is briefly closed.
 */
router.get('/session/:token', asyncHandler(async (req: Request, res: Response) => {
  const session = await payLinkService.resolve(req.params.token);
  res.status(200).json({ success: true, data: session });
}));

/**
 * POST /payments/:transactionId/pay-link
 *
 * Mint (or replace) the hosted card page's link for a transaction. **Authenticated and
 * scoped to the payer**, unlike the read above — and the asymmetry is the point: reading a
 * link requires holding one, while CREATING one is an act on somebody's payment and must be
 * attributable. An unauthenticated mint would let any caller turn any transaction id into a
 * live payment page, which is precisely the id-walking this design exists to prevent.
 *
 * The automation layer reaches the same operation through `POST /api/internal/bot/payments/
 * :transactionId/pay-link`, which scopes to the resolved messaging identity instead.
 *
 * A second call REPLACES the first — see `PayLinkService.mint`. That is how "the customer
 * lost the message" is answered safely.
 */
router.post('/:transactionId/pay-link', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { transactionId } = req.params;
  await assertTransactionOwnedByCaller(transactionId, req);

  const link = await payLinkService.mint(transactionId);
  res.status(200).json({ success: true, data: link });
}));

/**
 * GET /payments/:transactionId
 *
 * Get payment transaction details. **Authenticated, and scoped to the payer.**
 *
 * Authentication alone would not be enough here: transaction ids are the only
 * thing standing between one customer and another's payment record (amount,
 * gateway reference, the orders it settled), so any signed-in user could read
 * any payment by walking ids. The row is therefore matched against the caller
 * before it is returned, and a transaction that is not theirs 404s rather than
 * 403s — a 403 would confirm the id exists.
 *
 * Admins are exempt: disputes and refunds are handled from the platform side.
 *
 * RESPONSE:
 * {
 *   success: boolean,
 *   transaction: { ... }
 * }
 */
router.get('/:transactionId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { transactionId } = req.params;

  const transaction = await assertTransactionOwnedByCaller(transactionId, req, '-rawGatewayPayloads');

  res.status(200).json({ success: true, transaction });
}));

/**
 * The payer scoping both authenticated transaction routes share.
 *
 * ⚠ **One predicate, one place.** The read above and the mint below must agree on who owns a
 * transaction, and two copies of an ownership check are two chances to loosen one of them —
 * the mint in particular, being a write, is the one where a divergence would matter more and
 * be noticed less.
 *
 * ⚠ **`userId` is NOT one kind of id.** Order and cart payments store the CUSTOMER id
 * (`order.customer_id`); booking payments store the USER id (`booking.userId`, which refs
 * USER). Both are accepted rather than normalised — narrowing to one would lock the other's
 * payer out of their own receipt. See the note on the model.
 *
 * A transaction that is not the caller's 404s rather than 403s: a 403 would confirm the id
 * exists, which is the whole thing this scoping is for. Admins are exempt — disputes and
 * refunds are handled from the platform side.
 */
async function assertTransactionOwnedByCaller(
  transactionId: string,
  req: Request,
  projection?: string
): Promise<Record<string, unknown>> {
  if (!Types.ObjectId.isValid(transactionId)) {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  const { PaymentTransactionModel } = await import('../models/payment-transaction.model');
  const query = PaymentTransactionModel.findById(transactionId);
  if (projection) query.select(projection);
  const transaction = await query.lean();

  if (!transaction) {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  const owner = transaction.userId?.toString();
  const isOwner =
    owner === req.auth!.role_entity?._id?.toString() || owner === req.auth!.user.id?.toString();

  if (!isOwner && req.auth!.role !== 'admin') {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  return transaction as unknown as Record<string, unknown>;
}

export const paymentRouter = router;
