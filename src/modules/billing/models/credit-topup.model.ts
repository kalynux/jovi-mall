import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CreditTopup - A vendor's purchase of a credit pack.
 *
 * Created `pending` when the vendor initiates a top-up; flipped to `paid` by the
 * payment webhook (which then credits the wallet) or `failed` on gateway failure.
 */

export type CreditTopupStatus = 'pending' | 'paid' | 'failed';

/** Gateways reused from the payments module for charging a top-up. */
export type CreditTopupGateway = 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE';

export interface ICreditTopup extends Document {
  vendor_id: mongoose.Types.ObjectId;
  pack_code: string;
  credits: number;
  price: number;
  currency: string;
  status: CreditTopupStatus;
  /** Gateway used to charge this top-up, and its transaction reference. */
  gateway: CreditTopupGateway | null;
  gateway_ref: string | null;
  payment_transaction_id: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

const CreditTopupSchema = new Schema<ICreditTopup>(
  {
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    pack_code: { type: String, required: true, trim: true },
    credits: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    gateway: { type: String, enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'], default: null },
    gateway_ref: { type: String, default: null },
    payment_transaction_id: { type: Schema.Types.ObjectId, ref: MODELS.PAYMENT_TRANSACTION, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

CreditTopupSchema.index({ vendor_id: 1, created_at: -1 });

export const CreditTopupModel = mongoose.model<ICreditTopup>(
  MODELS.CREDIT_TOPUP,
  CreditTopupSchema,
  COLLECTIONS.CREDIT_TOPUP
);
