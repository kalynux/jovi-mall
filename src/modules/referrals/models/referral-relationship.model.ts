import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { REFERRED_CATEGORIES, ReferredCategory } from '../domain/referral-rules';

/**
 * Who referred whom. Written once, when a `users` row is created, and never changed.
 *
 * ⛔ **The unique index on `referred_user_id` IS the rule** that one person has one original
 * referrer, and it is what makes "one reward per account per commission" true by construction.
 *
 * `expires_at` is frozen at registration, so a later change of duration reaches new referrals only
 * and can never reactivate an expired one (document § 10). It is null on an `agent` relationship,
 * which is recorded for traceability and never earns (document § 13).
 */
export interface IReferralRelationship extends Document {
  partner_id: mongoose.Types.ObjectId;
  partner_user_id: mongoose.Types.ObjectId;
  referred_user_id: mongoose.Types.ObjectId;
  /** The role signed up with. Only this role earns (owner R-6). */
  category: ReferredCategory;
  code_used: string;
  /** How the code arrived. Traceability only. */
  channel: 'web' | 'whatsapp' | 'telegram';
  registered_at: Date;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ReferralRelationshipSchema = new Schema<IReferralRelationship>(
  {
    partner_id: { type: Schema.Types.ObjectId, ref: MODELS.REFERRAL_PARTNER, required: true },
    partner_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    referred_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    category: { type: String, enum: REFERRED_CATEGORIES, required: true },
    code_used: { type: String, required: true, uppercase: true, trim: true },
    channel: { type: String, enum: ['web', 'whatsapp', 'telegram'], required: true },
    registered_at: { type: Date, required: true },
    expires_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

ReferralRelationshipSchema.index({ referred_user_id: 1 }, { unique: true });
ReferralRelationshipSchema.index({ partner_id: 1, registered_at: -1 });

export const ReferralRelationshipModel = mongoose.model<IReferralRelationship>(
  MODELS.REFERRAL_RELATIONSHIP,
  ReferralRelationshipSchema,
  COLLECTIONS.REFERRAL_RELATIONSHIP
);
