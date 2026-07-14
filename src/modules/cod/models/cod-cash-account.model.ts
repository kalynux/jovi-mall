import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CodCashAccount - PHYSICAL CASH liability balance (not earnings).
 *
 * Two liability layers mirror how the cash physically travels back to the
 * platform (Agent → Agency → Platform):
 *  - owner_type 'agent':  cash the agent is holding — owed to their AGENCY.
 *    Rises at verified collection, falls when the agency records a deposit.
 *  - owner_type 'agency': cash the agency chain is accountable for — owed to
 *    the PLATFORM. Rises at verified collection (the agency answers for its
 *    agents immediately), falls when an admin confirms a remittance.
 *
 * Never mutate balances directly — go through CodCashAccountService, which
 * writes the balance AND an append-only CodCashLedger row in one transaction.
 *
 * Amounts are integers in minor currency units.
 */

export type CodCashOwnerType = 'agent' | 'agency';

export interface ICodCashAccount extends Document {
  owner_type: CodCashOwnerType;
  owner_id: mongoose.Types.ObjectId;
  /** Outstanding cash liability. Never negative. */
  balance: number;
  currency: string;
  /** Optimistic-lock/version counter (mirrors EarningsAccount). */
  version: number;
  created_at: Date;
  updated_at: Date;
}

const CodCashAccountSchema = new Schema<ICodCashAccount>(
  {
    owner_type: { type: String, enum: ['agent', 'agency'], required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// One cash account per owner.
CodCashAccountSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export const CodCashAccountModel = mongoose.model<ICodCashAccount>(
  MODELS.COD_CASH_ACCOUNT,
  CodCashAccountSchema,
  COLLECTIONS.COD_CASH_ACCOUNT
);
