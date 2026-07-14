import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * EarningsReserveHold - one scheduled slice of an agency's COD rolling
 * reserve.
 *
 * When a COD-sourced AGENCY allocation is released, RESERVE_PERCENT of it is
 * diverted into the account's `reserve_balance` and one of these rows is
 * created with `release_at = now + RESERVE_DAYS`. The daily earnings sweep
 * releases matured holds — but ONLY while the agency has no open cash
 * discrepancies (that's the whole point of the reserve).
 */

export type EarningsReserveHoldStatus = 'held' | 'released';

export interface IEarningsReserveHold extends Document {
  account_id: mongoose.Types.ObjectId;
  owner_type: 'agency';
  owner_id: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  /** The released allocation this reserve slice was carved from. */
  source_allocation_id: mongoose.Types.ObjectId;
  status: EarningsReserveHoldStatus;
  held_at: Date;
  release_at: Date;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const EarningsReserveHoldSchema = new Schema<IEarningsReserveHold>(
  {
    account_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ACCOUNT, required: true },
    owner_type: { type: String, enum: ['agency'], required: true, default: 'agency' },
    owner_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    source_allocation_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ALLOCATION, required: true },
    status: { type: String, enum: ['held', 'released'], required: true, default: 'held' },
    held_at: { type: Date, required: true },
    release_at: { type: Date, required: true },
    released_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Sweep: matured holds still held.
EarningsReserveHoldSchema.index({ status: 1, release_at: 1 });
EarningsReserveHoldSchema.index({ owner_id: 1, status: 1 });
// One reserve slice per released allocation (idempotency with the release claim).
EarningsReserveHoldSchema.index({ source_allocation_id: 1 }, { unique: true });

export const EarningsReserveHoldModel = mongoose.model<IEarningsReserveHold>(
  MODELS.EARNINGS_RESERVE_HOLD,
  EarningsReserveHoldSchema,
  COLLECTIONS.EARNINGS_RESERVE_HOLD
);
