import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * CreditTopup - An owner's purchase of a credit pack.
 *
 * Created `pending` when the owner (vendor/agency/agent) initiates a top-up;
 * flipped to `paid` by the payment webhook (which then credits the wallet) or
 * `failed` on gateway failure.
 */

export type CreditTopupStatus = 'pending' | 'paid' | 'failed' | 'reversed';

/** Gateways reused from the payments module for charging a top-up. */
export type CreditTopupGateway = 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE';

export interface ICreditTopup extends Document {
  owner_type: BillingOwnerType;
  owner_id: mongoose.Types.ObjectId;
  pack_code: string;
  credits: number;
  price: number;
  currency: string;
  status: CreditTopupStatus;
  /** Gateway used to charge this top-up, and its transaction reference. */
  gateway: CreditTopupGateway | null;
  gateway_ref: string | null;
  /**
   * OUR reference, echoed back by the gateway on its callback.
   *
   * This is what makes a mobile-money top-up settle from a webhook at all. A
   * top-up creates no `PaymentTransaction`, and the mobile gateways echo only a
   * reference string -- no metadata -- so before this field a NotchPay or
   * My-CoolPay callback reached an orchestrator that looked the reference up in
   * `payment_transaction`, found nothing, and answered success. Only a client
   * that stayed on the page and polled `/verify` ever completed one.
   */
  merchant_ref: string | null;
  payment_transaction_id: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

const CreditTopupSchema = new Schema<ICreditTopup>(
  {
    owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    pack_code: { type: String, required: true, trim: true },
    credits: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ['pending', 'paid', 'failed', 'reversed'], default: 'pending' },
    gateway: { type: String, enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'], default: null },
    gateway_ref: { type: String, default: null },
    // Sparse: every row written before this field existed has none, and a plain
    // unique index refuses the second null.
    merchant_ref: { type: String, default: null, unique: true, sparse: true, index: true },
    payment_transaction_id: { type: Schema.Types.ObjectId, ref: MODELS.PAYMENT_TRANSACTION, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

CreditTopupSchema.index({ owner_type: 1, owner_id: 1, created_at: -1 });

export const CreditTopupModel = mongoose.model<ICreditTopup>(
  MODELS.CREDIT_TOPUP,
  CreditTopupSchema,
  COLLECTIONS.CREDIT_TOPUP
);
