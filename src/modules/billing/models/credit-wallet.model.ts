import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CreditWallet - A running credit balance owned by a marketplace participant.
 *
 * `owner_type` is a discriminator so the same wallet powers vendors today and
 * delivery agencies later (agent-dispatch WhatsApp credits) with no schema
 * change. Exactly one wallet per (owner_type, owner_id), created lazily.
 *
 * Credits NEVER expire or reset: plan allowances, top-ups and leftovers from a
 * previous plan all accumulate here. `version` provides optimistic locking so
 * concurrent debits can't double-spend.
 */

export type WalletOwnerType = 'vendor' | 'agency';

export interface ICreditWallet extends Document {
  owner_type: WalletOwnerType;
  owner_id: mongoose.Types.ObjectId;
  balance: number;
  /** Unit of the balance. Always 'credit' — present for explicitness/forward-compat. */
  currency_unit: 'credit';
  version: number;
  created_at: Date;
  updated_at: Date;
}

const CreditWalletSchema = new Schema<ICreditWallet>(
  {
    owner_type: { type: String, enum: ['vendor', 'agency'], required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    currency_unit: { type: String, enum: ['credit'], default: 'credit' },
    version: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

CreditWalletSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export const CreditWalletModel = mongoose.model<ICreditWallet>(
  MODELS.CREDIT_WALLET,
  CreditWalletSchema,
  COLLECTIONS.CREDIT_WALLET
);
