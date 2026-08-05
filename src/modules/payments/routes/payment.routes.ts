import { Router, Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { InitiatePaymentSchema, VerifyPaymentSchema } from '../validators/payment.validators';

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

  if (!Types.ObjectId.isValid(transactionId)) {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  const { PaymentTransactionModel } = await import('../models/payment-transaction.model');
  const transaction = await PaymentTransactionModel.findById(transactionId)
    .select('-rawGatewayPayloads')
    .lean();

  if (!transaction) {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  // `userId` on a transaction is NOT one kind of id: order/cart payments store
  // the CUSTOMER id (`order.customer_id`), while booking payments store the USER
  // id (`booking.userId`, which refs USER). Both are accepted rather than
  // normalised here — narrowing to one would lock the other's payer out of their
  // own receipt. See the note on the model.
  const owner = transaction.userId?.toString();
  const isOwner =
    owner === req.auth!.role_entity?._id?.toString() || owner === req.auth!.user.id?.toString();

  if (!isOwner && req.auth!.role !== 'admin') {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  res.status(200).json({ success: true, transaction });
}));

export const paymentRouter = router;
