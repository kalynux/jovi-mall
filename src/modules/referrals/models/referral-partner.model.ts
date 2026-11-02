import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ActorSource } from '../../../core/types/actor-source.types';
import { IPayoutMethod, PayoutMethodSchema } from '../../../core/types/payout.types';
import {
  DURATION_MAX_MONTHS,
  DURATION_MIN_MONTHS,
  EarningCategory,
  PARTNER_STATUSES,
  PartnerStatus,
  PartnerOverrides,
  RATE_MAX_PERCENT,
  RATE_MIN_PERCENT,
} from '../domain/referral-rules';

/**
 * A referral partner. One per person, not per role, because one account can hold several roles and
 * the partner's wallet and code belong to the person (REFERRAL-PROGRAM-PLAN § 5.1).
 *
 * `status_history` is what `wasPartnerActiveAt` reads, so a commission is judged by the partner's
 * status on the day it was earned, not by today's. It is appended to on every change, in the same
 * write as the status.
 */

export interface IPartnerStatusChange {
  from: PartnerStatus | null;
  to: PartnerStatus;
  at: Date;
  actor_id: string | null;
  actor_source: ActorSource;
  actor_name: string | null;
  reason: string | null;
}

export interface IPartnerBalanceRelease {
  at: Date;
  actor_id: string | null;
  actor_name: string | null;
  reason: string;
}

export interface IReferralPartner extends Document {
  user_id: mongoose.Types.ObjectId;
  /** The role they applied from. Decides which payout destination is read first (owner R-4). */
  applied_as_role: string;
  status: PartnerStatus;
  /** Null until the first approval. Kept through suspension, termination and re-application. */
  code: string | null;
  motivation: string | null;
  terms_accepted_at: Date;
  applied_at: Date;
  approved_at: Date | null;
  /** The reason given for the latest rejection, suspension or termination. Shown to the partner. */
  status_reason: string | null;
  /** Only an administrator sets this, on a `rejected` or `terminated` partner (owner R-9). */
  can_reapply: boolean;
  /** Set by an administrator to let a suspended or terminated partner withdraw (owner R-9). */
  balance_released: IPartnerBalanceRelease | null;
  /** Used only when no role on the account holds a payout destination (owner R-4). */
  payout_details: IPayoutMethod[];
  custom_terms: PartnerOverrides;
  status_history: IPartnerStatusChange[];
  created_at: Date;
  updated_at: Date;
}

const StatusChangeSchema = new Schema<IPartnerStatusChange>(
  {
    from: { type: String, enum: [...PARTNER_STATUSES, null], default: null },
    to: { type: String, enum: PARTNER_STATUSES, required: true },
    at: { type: Date, required: true },
    actor_id: { type: String, default: null },
    actor_source: { type: String, enum: ['platform', 'admin'], default: 'platform' },
    actor_name: { type: String, default: null, trim: true, maxlength: 200 },
    reason: { type: String, default: null, trim: true, maxlength: 1000 },
  },
  { _id: false }
);

const OverrideSchema = new Schema(
  {
    rate_percent: { type: Number, default: null, min: RATE_MIN_PERCENT, max: RATE_MAX_PERCENT },
    duration_months: { type: Number, default: null, min: DURATION_MIN_MONTHS, max: DURATION_MAX_MONTHS },
  },
  { _id: false }
);

const ReferralPartnerSchema = new Schema<IReferralPartner>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    applied_as_role: { type: String, required: true },
    status: { type: String, enum: PARTNER_STATUSES, required: true, default: 'pending' },
    code: { type: String, default: null, uppercase: true, trim: true },
    motivation: { type: String, default: null, trim: true, maxlength: 1000 },
    terms_accepted_at: { type: Date, required: true },
    applied_at: { type: Date, required: true },
    approved_at: { type: Date, default: null },
    status_reason: { type: String, default: null, trim: true, maxlength: 1000 },
    can_reapply: { type: Boolean, required: true, default: false },
    balance_released: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          actor_id: { type: String, default: null },
          actor_name: { type: String, default: null, trim: true, maxlength: 200 },
          reason: { type: String, required: true, trim: true, maxlength: 1000 },
        },
        { _id: false }
      ),
      default: null,
    },
    payout_details: { type: [PayoutMethodSchema], default: [] },
    custom_terms: {
      vendor: { type: OverrideSchema, default: null },
      customer: { type: OverrideSchema, default: null },
      agency: { type: OverrideSchema, default: null },
    },
    status_history: { type: [StatusChangeSchema], default: [] },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

ReferralPartnerSchema.index({ user_id: 1 }, { unique: true });
// Partial because a partner holds no code until approved, and a plain unique index would allow only
// one such partner.
ReferralPartnerSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } }
);
ReferralPartnerSchema.index({ status: 1, applied_at: -1 });

export type { EarningCategory };

export const ReferralPartnerModel = mongoose.model<IReferralPartner>(
  MODELS.REFERRAL_PARTNER,
  ReferralPartnerSchema,
  COLLECTIONS.REFERRAL_PARTNER
);
