import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';
import { EarningsSourceType } from './earnings-allocation.model';

/**
 * EarningsLedger - Append-only audit of every money movement on an
 * EarningsAccount. Written inside the SAME transaction as the balance update so
 * balances and history can never diverge.
 *
 * `amount` is the (positive) magnitude moved; `entry_type` says what happened:
 *  - `hold`            money entered `pending_balance` (order/COD split).
 *  - `release`         money moved `pending_balance` → `available_balance`.
 *  - `reversal`        money left an account (refund clawback).
 *  - `reserve_hold`    money moved `pending_balance` → `reserve_balance`
 *                      (COD rolling reserve on agency earnings).
 *  - `reserve_release` money moved `reserve_balance` → `available_balance`.
 * `pending_after`/`available_after` snapshot the balances after the entry.
 */

export type EarningsLedgerEntryType =
  | 'hold'
  | 'release'
  | 'reversal'
  | 'reserve_hold'
  | 'reserve_release';

export type EarningsLedgerReasonCode =
  | 'order_split'
  | 'cod_split'
  | 'hold_release'
  | 'refund_reversal'
  | 'cod_rolling_reserve'
  | 'reserve_matured';

export interface IEarningsLedger extends Document {
  account_id: mongoose.Types.ObjectId;
  owner_type: EarningsOwnerType;
  owner_id: mongoose.Types.ObjectId | null;
  entry_type: EarningsLedgerEntryType;
  amount: number;
  pending_after: number;
  available_after: number;
  source_type: EarningsSourceType;
  source_id: mongoose.Types.ObjectId;
  allocation_id: mongoose.Types.ObjectId;
  reason_code: EarningsLedgerReasonCode;
  created_at: Date;
}

const EarningsLedgerSchema = new Schema<IEarningsLedger>(
  {
    account_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ACCOUNT, required: true },
    owner_type: { type: String, enum: ['vendor', 'agency', 'platform', 'agent'], required: true },
    owner_id: { type: Schema.Types.ObjectId, default: null },
    entry_type: {
      type: String,
      enum: ['hold', 'release', 'reversal', 'reserve_hold', 'reserve_release'],
      required: true,
    },
    amount: { type: Number, required: true },
    pending_after: { type: Number, required: true },
    available_after: { type: Number, required: true },
    source_type: { type: String, enum: ['order', 'booking', 'cod_collection'], required: true },
    source_id: { type: Schema.Types.ObjectId, required: true },
    allocation_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ALLOCATION, required: true },
    reason_code: {
      type: String,
      enum: ['order_split', 'cod_split', 'hold_release', 'refund_reversal', 'cod_rolling_reserve', 'reserve_matured'],
      required: true,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

EarningsLedgerSchema.index({ owner_type: 1, owner_id: 1, created_at: -1 });

export const EarningsLedgerModel = mongoose.model<IEarningsLedger>(
  MODELS.EARNINGS_LEDGER,
  EarningsLedgerSchema,
  COLLECTIONS.EARNINGS_LEDGER
);
