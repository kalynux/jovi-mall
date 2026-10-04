import mongoose, { Schema, Document, Types, ClientSession } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ACTOR_SOURCES, ActorSource } from '../../../core/types/actor-source.types';
import {
  DELIVERY_FEE_REFUND_STATUSES,
  DeliveryFeeRefundStatus,
  MANUAL_REFUND_PAYMENT_METHODS,
  MANUAL_REFUND_SETTLEMENT_METHODS,
  ManualRefundSettlementMethod,
} from '../domain/customer-fee-change.rules';

/**
 * Why delivery-fee money is owed back to a customer (ADR-A11 § Fee changes after checkout).
 *  - `fee_decrease`   a customer-paid fee went down after they had paid it (a proposal, a
 *                     change-agency move, a combined-price answer);
 *  - `rto_leftover`   the parcel came back: the agency earned its RTO fee and the rest of the
 *                     delivery money the customer paid is theirs (W-C's `rtoLeftoverShares`);
 *  - `sweep`          found owed by the recovery stage, cause not re-derived.
 */
export type DeliveryFeeRefundCause = 'fee_decrease' | 'rto_leftover' | 'sweep';
export const DELIVERY_FEE_REFUND_CAUSES: readonly DeliveryFeeRefundCause[] = ['fee_decrease', 'rto_leftover', 'sweep'];

/**
 * ONE attempt to give a customer back delivery-fee money on one order — the ledger the
 * outstanding amount is measured against (`outstandingCustomerRefund`).
 *
 * Keyed on the ORDER, deliberately not the shipment: a change-agency move deletes the source
 * shipment and carries its money to another one, and a refund recorded against the deleted row
 * must still count. `shipment_id` is informational.
 *
 *   processing       claimed, the gateway call is in flight. At most ONE per order (partial
 *                    unique index) — that is what makes two concurrent triggers (a decrease and a
 *                    return split) unable to pay the same money twice.
 *   completed        the gateway returned it (`refund_transaction_id` names the ledger row in
 *                    `refund_transactions`).
 *   manual_required  the gateway cannot or would not refund (mobile money, an account refunds are
 *                    disabled on, COD cash) — a HIGH ticket was opened and a person pays it.
 *                    Still CLAIMS the money, so the system never tries again on its own.
 *                    An administrator marks it settled (W-E2,
 *                    `POST /api/internal/admin/delivery-fee-refunds/:refundId/settle`): it becomes
 *                    `completed` with a `settlement` saying how, by whom and when.
 *   failed           the attempt moved nothing (lost before the gateway was asked). Does not claim.
 */
export interface IDeliveryFeeRefund extends Document {
  order_id: Types.ObjectId;
  shipment_id: Types.ObjectId | null;
  customer_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  amount: number;
  currency: string;
  status: DeliveryFeeRefundStatus;
  cause: DeliveryFeeRefundCause;
  /** The `refund_transactions` rows the gateway refund produced (one per payment leg). */
  refund_transaction_ids: Types.ObjectId[];
  /** Why it is manual / failed — operator-facing, never shown to the customer. */
  note: string | null;
  ticket_id: Types.ObjectId | null;
  settled_at: Date | null;
  /**
   * How a MANUAL refund was settled by an administrator (W-E2); null on every automatic row.
   * `settled_by_user_id` is a wi-admin administrator id (`settled_by_source: 'admin'`) — it
   * resolves to nothing in this database, hence the name snapshot.
   */
  settlement: IDeliveryFeeRefundSettlement | null;
  created_at: Date;
  updated_at: Date;
}

export interface IDeliveryFeeRefundSettlement {
  method: ManualRefundSettlementMethod;
  /** The transfer's own reference (mobile-money transaction id, bank reference). */
  reference: string | null;
  note: string | null;
  settled_by_user_id: string;
  settled_by_source: ActorSource;
  settled_by_name: string | null;
  settled_at: Date;
}

const DeliveryFeeRefundSettlementSchema = new Schema<IDeliveryFeeRefundSettlement>(
  {
    method: { type: String, enum: [...MANUAL_REFUND_SETTLEMENT_METHODS], required: true },
    reference: { type: String, default: null, trim: true, maxlength: 200 },
    note: { type: String, default: null, trim: true, maxlength: 1000 },
    settled_by_user_id: { type: String, required: true },
    settled_by_source: { type: String, enum: ACTOR_SOURCES, default: 'platform' },
    settled_by_name: { type: String, default: null, trim: true, maxlength: 200 },
    settled_at: { type: Date, required: true },
  },
  { _id: false }
);

const DeliveryFeeRefundSchema = new Schema<IDeliveryFeeRefund>(
  {
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, default: null },
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, enum: [...DELIVERY_FEE_REFUND_STATUSES], required: true, default: 'processing' },
    cause: { type: String, enum: [...DELIVERY_FEE_REFUND_CAUSES], required: true },
    refund_transaction_ids: { type: [Schema.Types.ObjectId], default: [] },
    note: { type: String, default: null, maxlength: 1000 },
    ticket_id: { type: Schema.Types.ObjectId, default: null },
    settled_at: { type: Date, default: null },
    settlement: { type: DeliveryFeeRefundSettlementSchema, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ── Indexes (built by `npm run migrate:delivery-fee-proposal-indexes`; keep in step) ──────────
// ONE refund in flight per order — the guarantee behind "two triggers cannot pay the same money".
DeliveryFeeRefundSchema.index(
  { order_id: 1 },
  { unique: true, partialFilterExpression: { status: 'processing' }, name: 'delivery_fee_refund_one_processing_per_order' }
);
// The ledger of one order (the outstanding computation and the customer's read).
DeliveryFeeRefundSchema.index({ order_id: 1, created_at: -1 }, { name: 'delivery_fee_refund_by_order' });
// The administrators' queue of refunds to pay by hand (W-E2) — `status: 'manual_required'`, newest first.
DeliveryFeeRefundSchema.index({ status: 1, created_at: -1 }, { name: 'delivery_fee_refund_admin_queue' });

export const DeliveryFeeRefundModel = mongoose.model<IDeliveryFeeRefund>(
  MODELS.DELIVERY_FEE_REFUND,
  DeliveryFeeRefundSchema,
  COLLECTIONS.DELIVERY_FEE_REFUND
);

/**
 * Delivery-fee money an administrator PAID BY HAND to the customer of these orders (W-E2) —
 * per order id. Money that left the platform without a `refund_transactions` row, so every
 * ceiling measured as `total_amount − Σ completed refund_transactions` must also subtract this,
 * or a later gateway refund of the whole order pays the same delivery money a second time
 * (`PaymentOrchestratorService` source ceiling, `DeliveryFeeRefundService` capacity). A
 * `covered_by_order_refund` settlement moved nothing and is not counted.
 */
export async function sumDeliveryRefundsPaidByHand(
  orderIds: Types.ObjectId[],
  session?: ClientSession
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const rows = await DeliveryFeeRefundModel.aggregate<{ _id: Types.ObjectId; total: number }>([
    {
      $match: {
        order_id: { $in: orderIds },
        status: 'completed',
        'settlement.method': { $in: [...MANUAL_REFUND_PAYMENT_METHODS] },
      },
    },
    { $group: { _id: '$order_id', total: { $sum: '$amount' } } },
  ]).session(session ?? null);
  for (const r of rows) out.set(r._id.toString(), r.total);
  return out;
}
