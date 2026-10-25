import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';
import { CourierHoldSnapshot } from '../domain/courier-hold';

/**
 * EarningsAllocation - The SOURCE OF TRUTH for one beneficiary's share of one
 * paid order/booking.
 *
 * When a payment succeeds the gross is split into allocations (vendor net,
 * platform commission, per-agency delivery fee). Each row is `held` immediately
 * (money sits in the beneficiary's `pending_balance`). When the source order is
 * completed, `completed_at`/`hold_release_at` are stamped; once the hold window
 * elapses the release worker flips the row to `released` and moves the money to
 * `available_balance`. A refund before release reverses the row.
 *
 * Amounts are integers in minor currency units.
 */

/**
 * 'cod_collection' allocations are sourced from ONE CashCollection (one COD
 * shipment's verified cash handoff — see src/modules/cod/), not a whole order:
 * COD orders collect per shipment, so they split per shipment too.
 *
 * 'shipment' allocations are the PREPAID mirror of that: the delivery fee on an
 * online-paid order is divided between the agency and the agent who made the
 * run, and neither is known until the shipment is delivered. See
 * EarningsSplitService.splitShipmentDelivery. Sourcing them by shipment (rather
 * than summing per agency onto the order, as the payment-time split used to) is
 * what lets one agency hold two shipments on one order without colliding on the
 * uniqueness index below.
 */
/**
 * 'agency_claim' (2026-10-22): the two shares a DAMAGE CLAIM creates — the vendor's compensation
 * and the platform's investigation fee (`agency-claim.service.ts`). Never an order's source, never
 * paused with one, never counted as a sale.
 */
export type EarningsSourceType = 'order' | 'booking' | 'cod_collection' | 'shipment' | 'agency_claim';
export type EarningsAllocationStatus = 'held' | 'released' | 'reversed';

export interface IEarningsAllocation extends Document {
  source_type: EarningsSourceType;
  source_id: mongoose.Types.ObjectId;

  beneficiary_type: EarningsOwnerType;
  /** Beneficiary id; `null` for the platform commission allocation. */
  beneficiary_id: mongoose.Types.ObjectId | null;

  /** Order/booking total at split time (audit snapshot). */
  gross_snapshot: number;
  /** Commission rate applied at split time (audit snapshot). */
  commission_percent_snapshot: number;
  /** This beneficiary's share (minor units). NEVER edited by a refund — see `clawed_amount`. */
  amount: number;
  /**
   * How much of `amount` refunds have taken back, cumulatively (0 ≤ x ≤ amount).
   * REFUND-FLOW-PLAN § 6.1: `amount` stays the split's own figure so NET_FORMULA keeps reading
   * it; what is left to release is `amount − clawed_amount`. When nothing is left the row
   * becomes `reversed` — from `held` OR from `released` — through a compare-and-set on this
   * field (`EarningsAllocationRepository.addClawed`). One `earnings_adjustments` row per claw.
   * Rows written before the field existed read as 0 (`migrate:earnings-clawback-fields`).
   */
  clawed_amount: number;
  currency: string;

  status: EarningsAllocationStatus;

  /**
   * When this row's hold STARTED. Despite the name (kept to avoid a migration): for an order
   * it is `Order.delivered_at`, the courier finishing the last parcel, since 2026-10-05; for a
   * booking it is the booking's completion. Completion is only the fallback for a row nobody
   * started. See earnings/domain/earnings-hold.ts.
   */
  completed_at: Date | null;
  /** completed_at + HOLD_DAYS; the release worker acts at/after this instant. */
  hold_release_at: Date | null;
  /**
   * Copied from the source's earnings pause so the release worker's QUERY can skip it. The
   * pause record on the Order/Booking is the truth; this is an index. A row created while its
   * source is already paused may lack it, which is why the worker re-checks the source before
   * releasing (and stamps this when it finds one).
   */
  paused_at: Date | null;
  released_at: Date | null;
  reversed_at: Date | null;

  /**
   * COD only: the money behind this allocation is physical cash travelling
   * Agent → Agency → Platform. Release is gated on BOTH hold maturation AND
   * `cash_settled_at` — the platform never releases earnings it hasn't
   * physically received (stamped by the remittance FIFO settlement, see
   * src/modules/cod/services/cod-settlement.service).
   */
  requires_cash_settlement: boolean;
  cash_settled_at: Date | null;

  /**
   * AGENCY and RIDER rows of a delivery only (owner decision, 2026-10-22): the agency's terms
   * as they stood when this share was written, and the hold they give it. Present ⇒ this row
   * runs on its OWN clock — started by its parcel (`syncShipmentCourierHold`), never by the
   * order's delivery or completion — and an administrator's ORDER pause skips it when
   * `days === 0`. Null on every other row and on rows written before the rule, which keep the
   * order-level hold. See earnings/domain/courier-hold.ts.
   */
  courier_hold: CourierHoldSnapshot | null;

  created_at: Date;
  updated_at: Date;
}

const EarningsAllocationSchema = new Schema<IEarningsAllocation>(
  {
    source_type: {
      type: String,
      enum: ['order', 'booking', 'cod_collection', 'shipment', 'agency_claim'],
      required: true,
    },
    source_id: { type: Schema.Types.ObjectId, required: true },

    beneficiary_type: { type: String, enum: ['vendor', 'agency', 'platform', 'agent', 'platform_ai'], required: true },
    beneficiary_id: { type: Schema.Types.ObjectId, default: null },

    gross_snapshot: { type: Number, required: true, min: 0 },
    commission_percent_snapshot: { type: Number, required: true, min: 0, max: 100 },
    amount: { type: Number, required: true, min: 0 },
    clawed_amount: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },

    status: { type: String, enum: ['held', 'released', 'reversed'], required: true, default: 'held' },

    completed_at: { type: Date, default: null },
    hold_release_at: { type: Date, default: null },
    paused_at: { type: Date, default: null },
    released_at: { type: Date, default: null },
    reversed_at: { type: Date, default: null },

    requires_cash_settlement: { type: Boolean, required: true, default: false },
    cash_settled_at: { type: Date, default: null },

    courier_hold: {
      type: new Schema(
        {
          shipment_id: { type: String, required: true },
          agency_id: { type: String, required: true },
          days: { type: Number, required: true, min: 0 },
          protection_days: { type: Number, required: true, min: 0 },
          returns_payer: { type: String, default: null },
          claim_deadline_days: { type: Number, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Idempotency: at most one allocation per (source, beneficiary). A re-fired
// payment webhook therefore cannot double-split the same order.
EarningsAllocationSchema.index(
  { source_type: 1, source_id: 1, beneficiary_type: 1, beneficiary_id: 1 },
  { unique: true }
);
// Release-worker sweep: held allocations whose hold window has elapsed.
EarningsAllocationSchema.index({ status: 1, hold_release_at: 1 });
// Beneficiary ledger/earnings queries.
EarningsAllocationSchema.index({ beneficiary_type: 1, beneficiary_id: 1, created_at: -1 });

export const EarningsAllocationModel = mongoose.model<IEarningsAllocation>(
  MODELS.EARNINGS_ALLOCATION,
  EarningsAllocationSchema,
  COLLECTIONS.EARNINGS_ALLOCATION
);
