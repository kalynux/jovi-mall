import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * PricingPlan - Admin-managed catalog of subscription tiers, scoped by role.
 *
 * Plans differ ONLY by price, credit allowance, max active products and
 * commission percentage — all other capabilities are universal across plans.
 * The free Starter tier has `term_days = null` (never expires) and `price = 0`.
 *
 * Seeded via `npm run seed:plans` (idempotent upsert by `role + code`) and
 * editable through the admin API.
 */

/** Role a plan belongs to. Only `vendor` is built for now; reserved for future roles. */
export type PlanRole = 'vendor';

export interface IPricingPlan extends Document {
  role: PlanRole;
  /** Stable, role-unique identifier (e.g. 'starter', 'growth', 'business'). */
  code: string;
  name: string;
  /** Price in `currency` per term. 0 for the free tier. */
  price: number;
  currency: string;
  /** Length of a paid term in days. `null` = never-expiring (free tier). */
  term_days: number | null;
  /** Credits granted ONCE when this plan is activated for a vendor. */
  credit_allowance: number;
  /** Max active products allowed. `null` = unlimited. */
  max_active_products: number | null;
  /** Marketplace commission percentage applied to the vendor's sales. */
  commission_percent: number;
  is_active: boolean;
  sort_order: number;
  deletedAt: Date | null;
  created_at: Date;
  updated_at: Date;
}

const PricingPlanSchema = new Schema<IPricingPlan>(
  {
    role: { type: String, enum: ['vendor'], required: true, default: 'vendor' },
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true, default: 'XAF' },
    term_days: { type: Number, default: null, min: 1 },
    credit_allowance: { type: Number, required: true, min: 0 },
    max_active_products: { type: Number, default: null, min: 0 },
    commission_percent: { type: Number, required: true, min: 0, max: 100 },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// A code is unique per role among non-deleted plans.
PricingPlanSchema.index(
  { role: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

export const PricingPlanModel = mongoose.model<IPricingPlan>(
  MODELS.PRICING_PLAN,
  PricingPlanSchema,
  COLLECTIONS.PRICING_PLAN
);
