import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { DELIVERY_FEE_REFUND_STATUSES, DeliveryFeeRefundStatus } from '../domain/customer-fee-change.rules';

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
  created_at: Date;
  updated_at: Date;
}

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

export const DeliveryFeeRefundModel = mongoose.model<IDeliveryFeeRefund>(
  MODELS.DELIVERY_FEE_REFUND,
  DeliveryFeeRefundSchema,
  COLLECTIONS.DELIVERY_FEE_REFUND
);
