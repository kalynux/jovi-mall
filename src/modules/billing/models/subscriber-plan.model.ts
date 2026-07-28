import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * SubscriberPlan - An owner's assignment to a pricing plan.
 *
 * `owner_type` + `owner_id` identify the subscriber (a vendor, agency or agent),
 * mirroring the credit wallet. An owner holds at most TWO non-terminal records:
 *   - one `active`            — the plan currently in force
 *   - one `pending_activation`— a plan bought in advance, scheduled to take over
 *                               the moment the active plan expires (no lost days)
 *
 * `expires_at` is null for the free/never-expiring tier. `allowance_granted`
 * guards the one-time credit grant so a plan can never be granted twice.
 *
 * (Formerly `VendorPlan`; generalized to owner scope — see billing.types and the
 * `migrate:billing-owner-scope` migration.)
 */

export type SubscriberPlanStatus = 'active' | 'pending_activation' | 'expired' | 'cancelled';

export interface ISubscriberPlan extends Document {
  owner_type: BillingOwnerType;
  owner_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  /** Denormalized plan code for fast entitlement reads without a populate. */
  plan_code: string;
  status: SubscriberPlanStatus;
  /** When this plan became active. Null while `pending_activation`. */
  started_at: Date | null;
  /** When this plan expires. Null for the never-expiring free tier. */
  expires_at: Date | null;
  /** Admin user who assigned the plan (null for the lazily-created free default). */
  assigned_by: mongoose.Types.ObjectId | null;
  /** Gateway transaction reference that paid for this term, if any. */
  payment_reference: string | null;
  /** True once the plan's credit allowance has been credited to the wallet. */
  allowance_granted: boolean;
  created_at: Date;
  updated_at: Date;
}

const SubscriberPlanSchema = new Schema<ISubscriberPlan>(
  {
    owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    plan_id: { type: Schema.Types.ObjectId, ref: MODELS.PRICING_PLAN, required: true },
    plan_code: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['active', 'pending_activation', 'expired', 'cancelled'],
      required: true,
    },
    started_at: { type: Date, default: null },
    expires_at: { type: Date, default: null },
    assigned_by: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    payment_reference: { type: String, default: null },
    allowance_granted: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Enforce the "at most one active + one pending" invariant per owner.
// Distinct index names are required since the key pattern is shared.
SubscriberPlanSchema.index(
  { owner_type: 1, owner_id: 1 },
  { unique: true, name: 'uniq_active_per_owner', partialFilterExpression: { status: 'active' } }
);
SubscriberPlanSchema.index(
  { owner_type: 1, owner_id: 1 },
  { unique: true, name: 'uniq_pending_per_owner', partialFilterExpression: { status: 'pending_activation' } }
);
// Worker scans active plans by expiry.
SubscriberPlanSchema.index({ status: 1, expires_at: 1 });

export const SubscriberPlanModel = mongoose.model<ISubscriberPlan>(
  MODELS.SUBSCRIBER_PLAN,
  SubscriberPlanSchema,
  COLLECTIONS.SUBSCRIBER_PLAN
);
