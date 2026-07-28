import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * BillingSettings - per-owner billing preferences for agencies and agents.
 *
 * The vendor equivalent (plan-expiry notice preference) lives on the richer
 * `VendorSettings` document; this owner-scoped store carries the same preference
 * for the new roles without bolting billing fields onto the agency/agent domain
 * models. Created lazily on first read/write. Exactly one per (owner_type, owner_id).
 */
export interface IBillingSettings extends Document {
  owner_type: BillingOwnerType;
  owner_id: mongoose.Types.ObjectId;
  /** Days before plan expiry to notify the owner. */
  notify_days_before_expiry: number;
  /**
   * When the owner was last alerted that they are over their (soft) unterminated
   * -shipment cap. Debounces the alert to once per crossing; cleared when the
   * owner drops back under cap. Agencies only today.
   */
  shipment_cap_alerted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const BillingSettingsSchema = new Schema<IBillingSettings>(
  {
    owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    notify_days_before_expiry: { type: Number, default: 7, min: 0, max: 90 },
    shipment_cap_alerted_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

BillingSettingsSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export const BillingSettingsModel = mongoose.model<IBillingSettings>(
  MODELS.BILLING_SETTINGS,
  BillingSettingsSchema,
  COLLECTIONS.BILLING_SETTINGS
);
