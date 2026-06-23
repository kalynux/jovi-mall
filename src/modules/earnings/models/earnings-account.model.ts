import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * EarningsAccount - A money balance owned by a marketplace participant.
 *
 * Unlike the CreditWallet (metering "credits"), this holds REAL money in minor
 * currency units (e.g. XAF). Funds split from a paid order land in
 * `pending_balance` (held in escrow) and only move to `available_balance`
 * (withdrawable) once the order is completed and the hold window elapses.
 *
 * `owner_type` is a discriminator: `vendor` and `agency` are keyed by their own
 * id; `platform` is a SINGLETON (`owner_id` is null) that accumulates marketplace
 * commission. Exactly one account per (owner_type, owner_id), created lazily.
 *
 * `version` provides optimistic locking; balance mutations use atomic `$inc`.
 */

export type EarningsOwnerType = 'vendor' | 'agency' | 'platform';

export interface IEarningsAccount extends Document {
  owner_type: EarningsOwnerType;
  /** Beneficiary id; `null` for the singleton platform account. */
  owner_id: mongoose.Types.ObjectId | null;
  currency: string;
  /** Held in escrow — not yet withdrawable. */
  pending_balance: number;
  /** Released — withdrawable (payout flow handled in a later phase). */
  available_balance: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const EarningsAccountSchema = new Schema<IEarningsAccount>(
  {
    owner_type: { type: String, enum: ['vendor', 'agency', 'platform'], required: true },
    owner_id: { type: Schema.Types.ObjectId, default: null },
    currency: { type: String, required: true, uppercase: true, trim: true, default: 'XAF' },
    pending_balance: { type: Number, required: true, default: 0, min: 0 },
    available_balance: { type: Number, required: true, default: 0, min: 0 },
    version: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// One account per (owner_type, owner_id). The platform account is a singleton:
// its `owner_id` is null, and this unique index treats null as a single value.
EarningsAccountSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export const EarningsAccountModel = mongoose.model<IEarningsAccount>(
  MODELS.EARNINGS_ACCOUNT,
  EarningsAccountSchema,
  COLLECTIONS.EARNINGS_ACCOUNT
);
