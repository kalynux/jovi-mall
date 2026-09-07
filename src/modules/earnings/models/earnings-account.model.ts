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
 * `owner_type` is a discriminator: `vendor`, `agency` and `agent` are keyed by
 * their own id; `platform` is a SINGLETON (`owner_id` is null) that accumulates
 * marketplace commission. Exactly one account per (owner_type, owner_id),
 * created lazily.
 *
 * Every owner type here is a party the PLATFORM owes money to and pays via the
 * payout pipeline — that is what earns a seat in this model. An agent's share of
 * the delivery fee is carved out of the agency's at split time (see
 * EarningsSplitService and the contract's `fee_split`), so the agent is paid by
 * the platform directly rather than by the agency out of its own pocket.
 *
 * `version` provides optimistic locking; balance mutations use atomic `$inc`.
 */

/**
 * `platform_ai` is the SECOND platform-owned singleton, and it is deliberately
 * not folded into `platform`.
 *
 * It holds the 30% of a negotiated line's uplift that funds the bargaining
 * agent's model spend (BARGAINING-AGENT-PLAN D-5). Keeping it apart from the
 * marketplace commission is the whole point: the two answer different questions
 * — "what does the marketplace earn" and "what did the AI cost us" — and summing
 * them into one balance makes the second unanswerable, which is the number the
 * feature has to be judged on. Like `platform` it is keyed by a `null` owner_id
 * and is never paid out (see PAYOUT_OWNER_TYPES).
 */
export type EarningsOwnerType = 'vendor' | 'agency' | 'platform' | 'agent' | 'platform_ai';

/**
 * The owner types the platform itself holds — a `null` `owner_id`, one row each.
 * Exported so the singleton rule is spread from ONE list rather than re-typed at
 * every `=== 'platform'` comparison; `EarningsAccountRepository.toOwnerId` is
 * what it exists for.
 */
export const PLATFORM_OWNER_TYPES: readonly EarningsOwnerType[] = ['platform', 'platform_ai'];

/** True for an owner type whose account is a singleton with no `owner_id`. */
export function isPlatformOwnerType(ownerType: EarningsOwnerType): boolean {
  return PLATFORM_OWNER_TYPES.includes(ownerType);
}

export interface IEarningsAccount extends Document {
  owner_type: EarningsOwnerType;
  /** Beneficiary id; `null` for the singleton platform account. */
  owner_id: mongoose.Types.ObjectId | null;
  currency: string;
  /** Held in escrow — not yet withdrawable. */
  pending_balance: number;
  /** Released — withdrawable (payout flow handled in a later phase). */
  available_balance: number;
  /**
   * COD rolling reserve (agencies only): a percentage of each released
   * COD-sourced agency allocation parks here for COD_CONFIG.RESERVE_DAYS and
   * moves to `available_balance` only while the agency has no open cash
   * discrepancies. Scheduling lives in EarningsReserveHold.
   */
  reserve_balance: number;
  /**
   * Earmarked for an in-flight payout request: money leaves `available_balance`
   * the instant a request is created (so it can't be requested twice) and either
   * leaves the ledger for good when an admin marks the request paid, or returns
   * to `available_balance` if the admin rejects it. See PayoutRequest.
   */
  requested_balance: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const EarningsAccountSchema = new Schema<IEarningsAccount>(
  {
    owner_type: { type: String, enum: ['vendor', 'agency', 'platform', 'agent', 'platform_ai'], required: true },
    owner_id: { type: Schema.Types.ObjectId, default: null },
    currency: { type: String, required: true, uppercase: true, trim: true, default: 'XAF' },
    pending_balance: { type: Number, required: true, default: 0, min: 0 },
    available_balance: { type: Number, required: true, default: 0, min: 0 },
    reserve_balance: { type: Number, required: true, default: 0, min: 0 },
    requested_balance: { type: Number, required: true, default: 0, min: 0 },
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
