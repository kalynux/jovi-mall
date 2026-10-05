import { ClientSession, Types } from 'mongoose';
import { PaymentTransactionModel } from '../models/payment-transaction.model';
import { IRefundTransaction, RefundTransactionModel } from '../models/refund-transaction.model';
import { OrderModel } from '../../orders/order.model';
import { Booking } from '../../booking/models/booking.model';

/**
 * The refund LEDGER writes, shared by the two paths that return money (REFUND-FLOW-PLAN § 3.4):
 *
 *   - `PaymentOrchestratorService.refundPayment` — the legacy synchronous card path, kept as a
 *     shim until wave 2 rewires its callers;
 *   - `RefundRequestService.complete` — every refund request, whatever channel it left by.
 *
 * Extracted rather than copied so the two cannot drift on the money invariants: the payment's
 * `totalRefunded` / `hasPartialRefund` / `REFUNDED`, and the source's `payment_status:
 * 'refunded'` on a FULL refund only. Every function takes the caller's session — these writes
 * only ever happen inside the transaction that records the refund.
 */

export type LedgerSource = { kind: 'order'; id: string } | { kind: 'booking'; id: string };

/**
 * Add `amount` to a payment's refunded total, atomically, and derive the two flags from the
 * NEW total in the same update (an aggregation-pipeline update, so a concurrent refund of the
 * same payment can never be lost between a read and a save). Returns the payment as it now
 * stands, or null when it does not exist.
 *
 * ⚠ A pipeline update bypasses Mongoose's timestamps, so `updatedAt` is set by hand.
 */
export async function applyRefundToPaymentInSession(
  paymentTransactionId: Types.ObjectId | string,
  amount: number,
  session: ClientSession
): Promise<{ totalRefunded: number; amountSnapshot: number; paymentFullyRefunded: boolean } | null> {
  const updated = await PaymentTransactionModel.findOneAndUpdate(
    { _id: new Types.ObjectId(String(paymentTransactionId)) },
    [
      { $set: { totalRefunded: { $add: [{ $ifNull: ['$totalRefunded', 0] }, amount] } } },
      {
        $set: {
          hasPartialRefund: {
            $and: [{ $gt: ['$totalRefunded', 0] }, { $lt: ['$totalRefunded', '$amountSnapshot'] }],
          },
          status: { $cond: [{ $gte: ['$totalRefunded', '$amountSnapshot'] }, 'REFUNDED', '$status'] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { new: true, session }
  )
    .select('totalRefunded amountSnapshot')
    .lean<{ totalRefunded: number; amountSnapshot: number } | null>()
    .exec();
  if (!updated) return null;
  return {
    totalRefunded: updated.totalRefunded,
    amountSnapshot: updated.amountSnapshot,
    paymentFullyRefunded: updated.totalRefunded >= updated.amountSnapshot,
  };
}

/** The source's own payment status flips to `refunded` on a FULL refund only — never on a partial. */
export async function markSourceRefundedInSession(source: LedgerSource, session: ClientSession): Promise<void> {
  if (source.kind === 'booking') {
    await Booking.updateOne(
      { _id: new Types.ObjectId(source.id) },
      { $set: { paymentStatus: 'refunded' } },
      { session }
    );
    return;
  }
  await OrderModel.updateOne(
    { _id: new Types.ObjectId(source.id) },
    { $set: { payment_status: 'refunded', updated_at: new Date() } },
    { session }
  );
}

/**
 * Insert one `refund_transactions` row inside the session — ARRAY form, because Mongoose reads
 * `{ session }` only when the first argument is an array; `create(doc, { session })` writes
 * OUTSIDE the transaction while looking transactional (the outbox lesson, CLAUDE.md).
 */
export async function writeRefundTransactionInSession(
  doc: Record<string, unknown>,
  session: ClientSession
): Promise<IRefundTransaction> {
  const [row] = await RefundTransactionModel.create([doc], { session });
  return row;
}

/** Σ `refundAmount` of COMPLETED ledger rows for one order (the per-order ceiling's "already"). */
export async function sumCompletedRefundsForOrder(orderId: string): Promise<number> {
  const [tally] = await RefundTransactionModel.aggregate<{ total: number }>([
    { $match: { orderId: new Types.ObjectId(orderId), status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$refundAmount' } } },
  ]);
  return tally?.total ?? 0;
}
