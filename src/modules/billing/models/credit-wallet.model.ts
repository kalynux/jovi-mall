import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * CreditWallet - A running credit balance owned by a marketplace participant.
 *
 * `owner_type` is a discriminator so the same wallet powers vendors, delivery
 * agencies and agents with no schema change. Exactly one wallet per
 * (owner_type, owner_id), created lazily.
 *
 * Credits NEVER expire or reset: plan allowances, top-ups and leftovers from a
 * previous plan all accumulate here. `version` provides optimistic locking so
 * concurrent debits can't double-spend.
 *
 * ⚠ **`balance` may be NEGATIVE, and the schema deliberately does not say `min: 0`**
 * (SERVICE-LISTINGS-PLAN L-10, L-11). A provider's grace reveal may take it below zero, down to
 * the vendor's own floor. The guard moved into the service: `debitIfSufficient`'s
 * `balance >= amount` filter refuses every ordinary debit a balance cannot cover — including
 * every debit while the balance is negative — and `debitAllowingDebt` is the one debit that may
 * cross zero (`test:service-listings-billing` pins its single caller). A `min: 0` here would
 * never have bound an `$inc` anyway (update validators are off), only a `save()` — which is
 * exactly where it would now throw on a legitimately indebted wallet.
 */

/** A wallet's owner type IS its plan role — see `billing.types.ts`. */
export type WalletOwnerType = BillingOwnerType;

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
    owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    // No `min`: see the header. The service is the guard.
    balance: { type: Number, required: true, default: 0 },
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
