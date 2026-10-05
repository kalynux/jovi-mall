import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PAYMENT_GATEWAY_NAMES, PaymentGatewayName } from '../gateways/gateway.interface';
import {
  OPEN_REFUND_STATUSES,
  REFUND_REQUEST_STATUSES,
  RefundRequestStatus,
  TransferLegStatus,
} from '../domain/refund-status';
import { REFUND_REASON_KINDS, RefundReasonKind } from '../domain/refund-attribution';
import type { RefundPaymentChannel } from '../domain/refund-fee';

/**
 * `refund_requests` — the MONEY-OUT lifecycle of a refund (REFUND-FLOW-PLAN § 3.1, § 11.1).
 *
 * The twin of `payout_requests`: a refund that leaves by transfer needs the same double-send
 * guard (claim before send, reference reused on retry), the same callback routing and the same
 * reconciliation sweep. `refund_transactions` stays what its readers already treat it as — the
 * LEDGER of money returned, written once, at completion (§ 3.4).
 *
 * ⚠ **wi-admin reads this collection DIRECTLY** (read-direct, write-via-internal-API). Field
 * names are the contract in § 11.1 and are snake_case on purpose; renaming one is a two-repo
 * change. The DTO wi-admin and the internal routes serve is the camelCase projection.
 *
 * Two fields are NOT in § 11.1 and exist for this service's own bookkeeping — wi-admin may read
 * them but nothing there depends on them:
 *   - `payment_legs[]` — which succeeded payment returns how much of the gross, fixed at
 *     creation. Completion writes one `refund_transactions` row per entry, so the per-payment
 *     ledger (`totalRefunded`) is exact even when two transfers to two numbers settle it.
 *   - `transfer_note` — "outcome unknown" text for a send that threw after the claim, kept
 *     apart from `transfer_failure_reason` so a status filter on the latter stays honest.
 *
 * One OPEN request per source (`refund_one_open_per_source`): two refunds cannot race on one
 * order. The partial filter is the same `$in` shape `payout_requests` already relies on.
 */

export type RefundSourceKind = 'order' | 'booking' | 'plan_purchase' | 'credit_topup';
export const REFUND_SOURCE_KINDS: readonly RefundSourceKind[] = Object.freeze([
  'order',
  'booking',
  'plan_purchase',
  'credit_topup',
] as RefundSourceKind[]);

export type RefundChannel = 'card_refund' | 'payout' | 'external';
export type RefundRequesterRole = 'vendor' | 'admin' | 'support' | 'system' | 'customer';
export type ExternalSettlementMethod = 'mobile_money' | 'cash' | 'bank' | 'other';
/** See `IRefundRequest.earnings_impact`. */
export type RefundEarningsImpact = 'clawback' | 'none';

export interface IRefundActorStamp {
  id: string | null;
  name: string | null;
  at: Date;
}

export interface IRefundTransferLeg {
  phone: string;
  /** NET sent through this transfer. */
  amount: number;
  /** Gross refunded through this transfer (`amount` + its share of the fee). */
  gross: number;
  /** `jm_rf_<32hex>` — leg 0's is `transfer_reference`. Minted at the first claim, REUSED on retry. */
  reference: string;
  gateway_ref: string | null;
  status: TransferLegStatus;
  failure_reason: string | null;
}

export interface IRefundPaymentLeg {
  payment_transaction_id: mongoose.Types.ObjectId;
  purpose: string | null;
  gateway: PaymentGatewayName;
  /** GROSS this payment returns. */
  amount: number;
  payer_phone: string | null;
  /** Card legs: Stripe's refund id once it answered. */
  gateway_refund_ref: string | null;
  /** Card legs: refunded at the gateway (a retry skips it). */
  refunded: boolean;
}

export interface IRefundRequest extends Document {
  source_kind: RefundSourceKind;
  source_id: mongoose.Types.ObjectId;
  order_number: string | null;
  vendor_id: mongoose.Types.ObjectId | null;
  customer_id: mongoose.Types.ObjectId | null;
  reason_kind: RefundReasonKind;
  reason: string | null;
  item_defective: boolean | null;
  override_policy: boolean;
  attribution: { goods: number; delivery: number };
  gross_amount: number;
  fee_rate: number;
  fee_amount: number;
  net_amount: number;
  currency: string;
  payment_channel: RefundPaymentChannel;
  channel: RefundChannel | null;
  destination: { phone: string; name: string; source: 'payer' | 'typed' } | null;
  destination_proof_file_id: mongoose.Types.ObjectId | null;
  cod_collection_ids: mongoose.Types.ObjectId[];
  status: RefundRequestStatus;
  requested_by: { id: string | null; role: RefundRequesterRole; name: string | null };
  approved_by: IRefundActorStamp | null;
  rejected_by: IRefundActorStamp | null;
  rejection_reason: string | null;
  transfer_reference: string | null;
  transfer_gateway: PaymentGatewayName | null;
  transfer_gateway_ref: string | null;
  transfer_failure_reason: string | null;
  transfer_note: string | null;
  transfer_legs: IRefundTransferLeg[];
  payment_legs: IRefundPaymentLeg[];
  external_settlement: {
    method: ExternalSettlementMethod;
    reference: string | null;
    proof_file_id: mongoose.Types.ObjectId;
    settled_by: { id: string | null; name: string | null };
    settled_at: Date;
    /**
     * The part paid BY HAND (review finding 4): the whole request, or — after a multi-transfer
     * refund part of which already succeeded — only the unpaid remainder. Null on rows written
     * before 2026-10-05 (read them as the whole request).
     */
    gross_amount: number | null;
    net_amount: number | null;
  } | null;
  ticket_id: mongoose.Types.ObjectId | null;
  refund_transaction_ids: mongoose.Types.ObjectId[];
  completed_at: Date | null;
  /**
   * Whether this refund touches anybody's earnings. NOT in § 11.1 — bookkeeping added by the
   * entry-points workstream (wi-admin may read it; nothing there depends on it).
   *   `clawback` (default): the source's earnings are PAUSED while the request is open and
   *              recovered by attribution when it completes (C-4, § 6).
   *   `none`:    money that was never allocated to anybody — a delivery-fee DECREASE or the
   *              unspent part of a customer-paid return fee (§ 6.2 "nothing"). No pause is
   *              raised and nothing is clawed back; the vendor is not party to it.
   */
  earnings_impact: RefundEarningsImpact;
  /**
   * When the earnings recovery of a COMPLETED order/booking request (`earnings_impact:
   * 'clawback'`) finished — the clawback AND the pause close. Null until then. Stamped on the
   * request rather than inferred from `earnings_adjustments`, because a refund whose in-scope
   * rows were all zero legitimately writes no adjustment. The nightly `RefundCashRecheckWorker`
   * re-runs the recovery for completed requests still null here (review finding 6).
   */
  earnings_settled_at: Date | null;
  /**
   * When a COMPLETED billing refund (`plan_purchase` / `credit_topup`) reversed what was bought
   * — the plan downgraded, or the credits debited back (review finding 2). Null until then;
   * the same nightly sweep retries it.
   */
  billing_reversed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ActorStampSchema = new Schema<IRefundActorStamp>(
  {
    id: { type: String, default: null },
    name: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const TransferLegSchema = new Schema<IRefundTransferLeg>(
  {
    phone: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    gross: { type: Number, required: true, min: 0 },
    reference: { type: String, required: true },
    gateway_ref: { type: String, default: null },
    status: { type: String, enum: ['pending', 'sending', 'succeeded', 'failed'], required: true },
    failure_reason: { type: String, default: null },
  },
  { _id: false }
);

const PaymentLegSchema = new Schema<IRefundPaymentLeg>(
  {
    payment_transaction_id: { type: Schema.Types.ObjectId, ref: MODELS.PAYMENT_TRANSACTION, required: true },
    purpose: { type: String, default: null },
    gateway: { type: String, enum: [...PAYMENT_GATEWAY_NAMES], required: true },
    amount: { type: Number, required: true, min: 0 },
    payer_phone: { type: String, default: null },
    gateway_refund_ref: { type: String, default: null },
    refunded: { type: Boolean, default: false },
  },
  { _id: false }
);

const RefundRequestSchema = new Schema<IRefundRequest>(
  {
    source_kind: { type: String, enum: [...REFUND_SOURCE_KINDS], required: true },
    source_id: { type: Schema.Types.ObjectId, required: true },
    order_number: { type: String, default: null },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, default: null },
    customer_id: { type: Schema.Types.ObjectId, default: null },
    reason_kind: { type: String, enum: [...REFUND_REASON_KINDS], required: true },
    reason: { type: String, default: null, maxlength: 2000 },
    item_defective: { type: Boolean, default: null },
    override_policy: { type: Boolean, default: false },
    attribution: {
      goods: { type: Number, required: true, min: 0 },
      delivery: { type: Number, required: true, min: 0 },
    },
    gross_amount: { type: Number, required: true, min: 0 },
    fee_rate: { type: Number, required: true, min: 0 },
    fee_amount: { type: Number, required: true, min: 0 },
    net_amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    payment_channel: { type: String, enum: ['card', 'mobile_money', 'cod', 'billing'], required: true },
    channel: { type: String, enum: ['card_refund', 'payout', 'external', null], default: null },
    destination: {
      type: new Schema(
        {
          phone: { type: String, required: true },
          name: { type: String, required: true },
          source: { type: String, enum: ['payer', 'typed'], required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    destination_proof_file_id: { type: Schema.Types.ObjectId, default: null },
    cod_collection_ids: { type: [Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: [...REFUND_REQUEST_STATUSES], required: true },
    requested_by: {
      id: { type: String, default: null },
      role: { type: String, enum: ['vendor', 'admin', 'support', 'system', 'customer'], required: true },
      name: { type: String, default: null },
    },
    approved_by: { type: ActorStampSchema, default: null },
    rejected_by: { type: ActorStampSchema, default: null },
    rejection_reason: { type: String, default: null },
    transfer_reference: { type: String, default: null },
    transfer_gateway: { type: String, enum: [...PAYMENT_GATEWAY_NAMES, null], default: null },
    transfer_gateway_ref: { type: String, default: null },
    transfer_failure_reason: { type: String, default: null },
    transfer_note: { type: String, default: null },
    transfer_legs: { type: [TransferLegSchema], default: [] },
    payment_legs: { type: [PaymentLegSchema], default: [] },
    external_settlement: {
      type: new Schema(
        {
          method: { type: String, enum: ['mobile_money', 'cash', 'bank', 'other'], required: true },
          reference: { type: String, default: null },
          proof_file_id: { type: Schema.Types.ObjectId, required: true },
          settled_by: {
            id: { type: String, default: null },
            name: { type: String, default: null },
          },
          settled_at: { type: Date, required: true },
          gross_amount: { type: Number, default: null, min: 0 },
          net_amount: { type: Number, default: null, min: 0 },
        },
        { _id: false }
      ),
      default: null,
    },
    ticket_id: { type: Schema.Types.ObjectId, default: null },
    refund_transaction_ids: { type: [Schema.Types.ObjectId], default: [] },
    completed_at: { type: Date, default: null },
    earnings_impact: { type: String, enum: ['clawback', 'none'], default: 'clawback' },
    earnings_settled_at: { type: Date, default: null },
    billing_reversed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/** One OPEN request per source — the race guard two concurrent refunds collide on. */
RefundRequestSchema.index(
  { source_kind: 1, source_id: 1 },
  {
    name: 'refund_one_open_per_source',
    unique: true,
    partialFilterExpression: { status: { $in: [...OPEN_REFUND_STATUSES] } },
  }
);
/** Callback + reconciliation lookup by OUR reference (every leg's). */
RefundRequestSchema.index({ 'transfer_legs.reference': 1 }, { name: 'refund_transfer_leg_reference' });
/** The queue: by status, newest first; and the reconciliation sweep's `sending` scan. */
RefundRequestSchema.index({ status: 1, created_at: -1 });
RefundRequestSchema.index({ status: 1, updated_at: 1 });
/** COD: requests waiting on a collection's coverage. */
RefundRequestSchema.index({ cod_collection_ids: 1, status: 1 });
/** Per-source history (every request, open or closed). */
RefundRequestSchema.index({ source_id: 1, created_at: -1 });

export const RefundRequestModel = mongoose.model<IRefundRequest>(
  MODELS.REFUND_REQUEST,
  RefundRequestSchema,
  COLLECTIONS.REFUND_REQUEST
);
