import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { WalletOwnerType } from './credit-wallet.model';

/**
 * CreditTransaction - Append-only ledger of every credit movement.
 *
 * Written inside the same transaction as the wallet balance update so the
 * balance and its history can never diverge. `amount` is signed (+credit,
 * -debit); `balance_after` snapshots the resulting balance for auditability.
 */

export type CreditTransactionType =
  | 'allowance'   // plan activation grant
  | 'topup'       // purchased credit pack
  | 'debit'       // metered action (vectorisation, whatsapp template)
  | 'adjustment'  // manual admin correction
  | 'refund';

export type CreditReasonCode =
  | 'plan_allowance'
  | 'topup_purchase'
  | 'vectorisation'
  | 'whatsapp_template'
  | 'admin_adjustment';

export interface ICreditTransaction extends Document {
  wallet_id: mongoose.Types.ObjectId;
  owner_type: WalletOwnerType;
  owner_id: mongoose.Types.ObjectId;
  type: CreditTransactionType;
  /** Signed amount: positive credits the wallet, negative debits it. */
  amount: number;
  balance_after: number;
  reason_code: CreditReasonCode;
  /** Free-form reference to the originating entity (productId, messageId, topupId, planId). */
  ref: string | null;
  created_at: Date;
}

const CreditTransactionSchema = new Schema<ICreditTransaction>(
  {
    wallet_id: { type: Schema.Types.ObjectId, ref: MODELS.CREDIT_WALLET, required: true },
    owner_type: { type: String, enum: ['vendor', 'agency'], required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    type: {
      type: String,
      enum: ['allowance', 'topup', 'debit', 'adjustment', 'refund'],
      required: true,
    },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true },
    reason_code: {
      type: String,
      enum: ['plan_allowance', 'topup_purchase', 'vectorisation', 'whatsapp_template', 'admin_adjustment'],
      required: true,
    },
    ref: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

CreditTransactionSchema.index({ owner_type: 1, owner_id: 1, created_at: -1 });

export const CreditTransactionModel = mongoose.model<ICreditTransaction>(
  MODELS.CREDIT_TRANSACTION,
  CreditTransactionSchema,
  COLLECTIONS.CREDIT_TRANSACTION
);
