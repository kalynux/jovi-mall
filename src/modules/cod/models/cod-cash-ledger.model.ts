import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { CodCashOwnerType } from './cod-cash-account.model';

/**
 * CodCashLedger - append-only audit trail of every physical-cash liability
 * movement, written in the SAME transaction as the CodCashAccount balance
 * change (mirrors EarningsLedger). Nobody edits history — only appends.
 *
 * entry_type / ref_type:
 *  - 'collection' / 'cash_collection':   +amount (agent collected cash)
 *  - 'deposit'    / 'agent_deposit':     -amount on the agent account
 *  - 'remittance' / 'agency_remittance': -amount on the agency account
 *  - 'adjustment' / 'admin_adjustment':  signed admin correction
 */

export type CodCashLedgerEntryType = 'collection' | 'deposit' | 'remittance' | 'adjustment';
export type CodCashLedgerRefType =
  | 'cash_collection'
  | 'agent_deposit'
  | 'agency_remittance'
  | 'admin_adjustment';

export interface ICodCashLedger extends Document {
  account_id: mongoose.Types.ObjectId;
  owner_type: CodCashOwnerType;
  owner_id: mongoose.Types.ObjectId;
  entry_type: CodCashLedgerEntryType;
  /** Signed movement (positive = liability up, negative = liability down). */
  amount: number;
  /** Account balance immediately after this movement (audit snapshot). */
  balance_after: number;
  ref_type: CodCashLedgerRefType;
  ref_id: mongoose.Types.ObjectId;
  created_at: Date;
}

const CodCashLedgerSchema = new Schema<ICodCashLedger>(
  {
    account_id: { type: Schema.Types.ObjectId, ref: MODELS.COD_CASH_ACCOUNT, required: true },
    owner_type: { type: String, enum: ['agent', 'agency'], required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    entry_type: {
      type: String,
      enum: ['collection', 'deposit', 'remittance', 'adjustment'],
      required: true,
    },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true, min: 0 },
    ref_type: {
      type: String,
      enum: ['cash_collection', 'agent_deposit', 'agency_remittance', 'admin_adjustment'],
      required: true,
    },
    ref_id: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

CodCashLedgerSchema.index({ owner_type: 1, owner_id: 1, created_at: -1 });

export const CodCashLedgerModel = mongoose.model<ICodCashLedger>(
  MODELS.COD_CASH_LEDGER,
  CodCashLedgerSchema,
  COLLECTIONS.COD_CASH_LEDGER
);
