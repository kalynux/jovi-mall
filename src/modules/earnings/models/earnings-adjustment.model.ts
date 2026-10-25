import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';
import { EarningsSourceType } from './earnings-allocation.model';

/**
 * EarningsAdjustment — append-only record of every refund CLAWBACK, every DEBT RECOVERY and
 * every WRITE-OFF (REFUND-FLOW-PLAN § 6.1, contract § 11.3). wi-admin reads it directly.
 *
 * ── Kinds ──────────────────────────────────────────────────────────────────────
 *  - `refund_clawback`   one row per (refund × allocation): `amount` is what this refund took
 *                        back from that share, and equals the increase of the allocation's
 *                        `clawed_amount`. A row with `allocation_id: null` is the part of a
 *                        refund charged to the VENDOR beyond what their shares had left (C-1:
 *                        delivery money refunded on the vendor's return-shipping setting); it
 *                        is taken from available, then debt.
 *  - `clawback_recovery` debt (`clawback_balance`) paid down by an inflow to available.
 *                        `allocation_id` is the allocation whose release paid it, or null
 *                        (a payout returned to available). Its `refund_key` is its own:
 *                        `recovery:<allocationId>`, `recovery:reserve:<holdId>`,
 *                        `recovery:payout:<payoutRequestId>:<event>`.
 *  - `write_off`         an administrator forgave debt (C-6). `refund_key` = `write_off:<id>`.
 *
 * ── `taken_from` ───────────────────────────────────────────────────────────────
 * For a clawback, where the money came from: `pending` (a held share), `reserve` (the
 * share's own COD reserve slice), `available`, and `debt` (nothing could cover it — the owner
 * now owes it). The four always sum to `amount`. For a recovery, `debt` is the debt repaid
 * (the inflow diverted from available); for a write-off, `debt` is the debt forgiven.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────────
 * Unique on `{refund_key, allocation_id, kind}`: a refund processed twice recovers nothing
 * the second time — the duplicate insert aborts its whole transaction.
 */

export type EarningsAdjustmentKind = 'refund_clawback' | 'write_off' | 'clawback_recovery';

export interface AdjustmentTakenFrom {
  pending: number;
  reserve: number;
  available: number;
  debt: number;
}

export interface IEarningsAdjustment extends Document {
  refund_key: string;
  allocation_id: mongoose.Types.ObjectId | null;
  source_type: EarningsSourceType | null;
  source_id: mongoose.Types.ObjectId | null;
  beneficiary_type: EarningsOwnerType;
  beneficiary_id: mongoose.Types.ObjectId | null;
  amount: number;
  currency: string;
  taken_from: AdjustmentTakenFrom;
  kind: EarningsAdjustmentKind;
  /**
   * Clawbacks only: how much of `amount` answers the refund's GOODS and how much its
   * DELIVERY money (C-1). Sum to `amount`.
   */
  goods_amount: number;
  delivery_amount: number;
  /**
   * Clawbacks only: the WHOLE refund's attribution, copied on every row it wrote. Partial
   * refunds are computed cumulatively (so they add up to the full-refund outcome exactly), and
   * this is how the next refund knows what the earlier ones were worth.
   */
  refund_attribution: { goods: number; delivery: number } | null;
  actor: { id: string | null; name: string | null } | null;
  /** Write-offs: the administrator's reason. Otherwise null. */
  reason: string | null;
  /**
   * WHY, for the person it happened to (2026-10-22, `domain/adjustment-explanations.ts`): a closed
   * code, the numbers the sentence quotes, and the English sentence. Null on rows written before.
   */
  reason_code: string | null;
  reason_params: Record<string, unknown> | null;
  explanation: string | null;
  /** The refund request behind a refund clawback, when there is one. */
  refund_request_id: mongoose.Types.ObjectId | null;
  /** The damage claim behind a charge (`agency_claims`), when there is one. */
  agency_claim_id: mongoose.Types.ObjectId | null;
  /** The part of `amount` that is fees (seller-cancel fees, a lost dispute's pay-in fee). */
  fee_amount: number;
  created_at: Date;
}

const TakenFromSchema = new Schema<AdjustmentTakenFrom>(
  {
    pending: { type: Number, required: true, default: 0, min: 0 },
    reserve: { type: Number, required: true, default: 0, min: 0 },
    available: { type: Number, required: true, default: 0, min: 0 },
    debt: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false }
);

const EarningsAdjustmentSchema = new Schema<IEarningsAdjustment>(
  {
    refund_key: { type: String, required: true, trim: true },
    allocation_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ALLOCATION, default: null },
    source_type: { type: String, enum: ['order', 'booking', 'cod_collection', 'shipment', 'agency_claim', null], default: null },
    source_id: { type: Schema.Types.ObjectId, default: null },
    beneficiary_type: {
      type: String,
      enum: ['vendor', 'agency', 'platform', 'agent', 'platform_ai'],
      required: true,
    },
    beneficiary_id: { type: Schema.Types.ObjectId, default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true, default: 'XAF' },
    taken_from: { type: TakenFromSchema, required: true },
    kind: { type: String, enum: ['refund_clawback', 'write_off', 'clawback_recovery'], required: true },
    goods_amount: { type: Number, default: 0, min: 0 },
    delivery_amount: { type: Number, default: 0, min: 0 },
    refund_attribution: {
      type: new Schema({ goods: Number, delivery: Number }, { _id: false }),
      default: null,
    },
    actor: {
      type: new Schema({ id: { type: String, default: null }, name: { type: String, default: null } }, { _id: false }),
      default: null,
    },
    reason: { type: String, default: null, trim: true, maxlength: 500 },
    reason_code: { type: String, default: null },
    reason_params: { type: Schema.Types.Mixed, default: null },
    explanation: { type: String, default: null, maxlength: 1000 },
    refund_request_id: { type: Schema.Types.ObjectId, default: null },
    agency_claim_id: { type: Schema.Types.ObjectId, default: null },
    /** Part of `amount` that is FEES (seller-cancel payment + transfer fees, a lost dispute's pay-in fee). */
    fee_amount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

// THE idempotency guarantee (contract § 11.3): one row per (refund × allocation × kind).
EarningsAdjustmentSchema.index(
  { refund_key: 1, allocation_id: 1, kind: 1 },
  { unique: true, name: 'earnings_adjustment_once_per_refund_allocation' }
);
// Cumulative partial refunds: every earlier claw of an allocation in scope.
EarningsAdjustmentSchema.index({ allocation_id: 1, kind: 1 });
// The vendor-overflow rows of one source, and the analytics / statements readers.
EarningsAdjustmentSchema.index({ source_type: 1, source_id: 1, kind: 1 });
EarningsAdjustmentSchema.index({ beneficiary_type: 1, beneficiary_id: 1, created_at: -1 });
// wi-admin's platform transactions list (BR-030) walks this collection by `(created, _id)` keyset,
// platform-wide. Without it that walk is a collection scan and an in-memory sort.
EarningsAdjustmentSchema.index({ created_at: -1, _id: -1 }, { name: 'admin_transactions_feed' });

export const EarningsAdjustmentModel = mongoose.model<IEarningsAdjustment>(
  MODELS.EARNINGS_ADJUSTMENT,
  EarningsAdjustmentSchema,
  COLLECTIONS.EARNINGS_ADJUSTMENT
);
