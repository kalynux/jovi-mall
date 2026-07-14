import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';

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
 */
export type EarningsSourceType = 'order' | 'booking' | 'cod_collection';
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
  /** This beneficiary's share (minor units). */
  amount: number;
  currency: string;

  status: EarningsAllocationStatus;

  /** When the source order/booking was completed (customer confirmed / auto). */
  completed_at: Date | null;
  /** completed_at + HOLD_DAYS; the release worker acts at/after this instant. */
  hold_release_at: Date | null;
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

  created_at: Date;
  updated_at: Date;
}

const EarningsAllocationSchema = new Schema<IEarningsAllocation>(
  {
    source_type: { type: String, enum: ['order', 'booking', 'cod_collection'], required: true },
    source_id: { type: Schema.Types.ObjectId, required: true },

    beneficiary_type: { type: String, enum: ['vendor', 'agency', 'platform'], required: true },
    beneficiary_id: { type: Schema.Types.ObjectId, default: null },

    gross_snapshot: { type: Number, required: true, min: 0 },
    commission_percent_snapshot: { type: Number, required: true, min: 0, max: 100 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },

    status: { type: String, enum: ['held', 'released', 'reversed'], required: true, default: 'held' },

    completed_at: { type: Date, default: null },
    hold_release_at: { type: Date, default: null },
    released_at: { type: Date, default: null },
    reversed_at: { type: Date, default: null },

    requires_cash_settlement: { type: Boolean, required: true, default: false },
    cash_settled_at: { type: Date, default: null },
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
