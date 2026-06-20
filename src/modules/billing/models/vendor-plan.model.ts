import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * VendorPlan - A vendor's assignment to a pricing plan.
 *
 * A vendor holds at most TWO non-terminal records at once:
 *   - one `active`            — the plan currently in force
 *   - one `pending_activation`— a plan bought in advance, scheduled to take over
 *                               the moment the active plan expires (no lost days)
 *
 * `expires_at` is null for the free/never-expiring tier. `allowance_granted`
 * guards the one-time credit grant so a plan can never be granted twice.
 */

export type VendorPlanStatus = 'active' | 'pending_activation' | 'expired' | 'cancelled';

export interface IVendorPlan extends Document {
  vendor_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  /** Denormalized plan code for fast entitlement reads without a populate. */
  plan_code: string;
  status: VendorPlanStatus;
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

const VendorPlanSchema = new Schema<IVendorPlan>(
  {
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
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

// Enforce the "at most one active + one pending" invariant per vendor.
// Distinct index names are required since the key pattern is shared.
VendorPlanSchema.index(
  { vendor_id: 1 },
  { unique: true, name: 'uniq_active_per_vendor', partialFilterExpression: { status: 'active' } }
);
VendorPlanSchema.index(
  { vendor_id: 1 },
  { unique: true, name: 'uniq_pending_per_vendor', partialFilterExpression: { status: 'pending_activation' } }
);
// Worker scans active plans by expiry.
VendorPlanSchema.index({ status: 1, expires_at: 1 });

export const VendorPlanModel = mongoose.model<IVendorPlan>(
  MODELS.VENDOR_PLAN,
  VendorPlanSchema,
  COLLECTIONS.VENDOR_PLAN
);
