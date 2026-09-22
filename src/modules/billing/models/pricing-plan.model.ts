import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * PricingPlan - Admin-managed catalog of subscription tiers, scoped by role.
 *
 * Every role (vendor, agency, agent) has its own tiers. Plans differ only by
 * price, credit allowance and a handful of role-specific limits — all other
 * capabilities are universal across plans within a role. The free tier of each
 * role has `term_days = null` (never expires) and `price = 0`.
 *
 * Role-specific limit fields are nullable/optional so a plan carries only the
 * limits its role uses:
 *   - vendor → `max_active_products`, `commission_percent`
 *   - agency / agent → `max_unterminated_shipments`
 *   - agent → `max_cod_pool` (the COD cash ceiling; ⚠ `null` means ZERO, not unlimited)
 *   - `max_storage_bytes` → media-storage cap, applies to vendor/agency/agent
 *   - `live_tracking_enabled` applies to agency/agent (see below), universal today
 *
 * Seeded via `npm run seed:plans` (idempotent upsert by `role + code`) and
 * editable through the admin API.
 */

/** Role a plan belongs to — identical to the wallet owner type (see billing.types). */
export type PlanRole = BillingOwnerType;

export interface IPricingPlan extends Document {
  role: PlanRole;
  /** Stable, role-unique identifier (e.g. 'starter', 'growth', 'agency_free'). */
  code: string;
  name: string;
  /** Price in `currency` per term. 0 for the free tier. */
  price: number;
  currency: string;
  /** Length of a paid term in days. `null` = never-expiring (free tier). */
  term_days: number | null;
  /** Credits granted ONCE when this plan is activated for the owner. */
  credit_allowance: number;

  // ── Vendor-only limits (null/absent for agency & agent plans) ───────────────
  /** Max active products allowed. `null` = unlimited. */
  max_active_products: number | null;
  /**
   * Max total media storage in bytes. Applies to vendor, agency AND agent plans.
   * For vendors this excludes digital-product assets (billed under their own
   * per-asset cap). `null` = falls back to EntitlementService's default cap.
   */
  max_storage_bytes: number | null;
  /** Marketplace commission percentage applied to the vendor's sales. */
  commission_percent: number | null;

  // ── Agency / agent limits (null/absent for vendor plans) ────────────────────
  /**
   * Max "unterminated" shipments the owner may hold at once. For an agency this
   * is a soft cap (surfaced + alerted, never blocks checkout); for an agent it
   * drives `capacity.max_active_shipments` and is enforced hard on accept.
   * `null` = unlimited.
   */
  max_unterminated_shipments: number | null;

  // ── Agent-only limit (null/absent for vendor & agency plans) ────────────────
  /**
   * The COD pool ceiling this plan grants a **KYC-verified** agent: the most
   * cash-on-delivery money they may carry across every agency combined, in XAF.
   * An unverified agent's pool is 0 whatever their plan says.
   *
   * Written onto `DeliveryAgent.cod.pool_ceiling` / `cod.max_threshold` by the
   * agents module (`AgentCodPoolService`) — on `plan.activated`, on a KYC
   * verdict, on `pricing_plan.updated` when this value is edited in place, and
   * by the nightly `AgentCodPoolReconcileWorker`. Billing never writes the agent.
   *
   * ⚠ **`null` means ZERO, not unlimited** — the one limit on this model that
   * fails closed. The others are capacity; this one is cash, and a plan an
   * administrator creates without naming it must not hand agents the platform's
   * whole `AGENT_COD_THRESHOLD_MAX`. Values above that ceiling are clamped by the
   * reader, not refused here: billing does not import the agents config.
   */
  max_cod_pool: number | null;
  /**
   * Whether live GPS tracking is available on this plan. Defaults `true` on every
   * seeded tier today (tracking is universal); reserved as a future free-tier
   * restriction — see EntitlementService.isLiveTrackingEnabled.
   */
  live_tracking_enabled: boolean;

  is_active: boolean;
  sort_order: number;
  deletedAt: Date | null;
  created_at: Date;
  updated_at: Date;
}

const PricingPlanSchema = new Schema<IPricingPlan>(
  {
    role: { type: String, enum: BILLING_OWNER_TYPES, required: true, default: 'vendor' },
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true, default: 'XAF' },
    term_days: { type: Number, default: null, min: 1 },
    credit_allowance: { type: Number, required: true, min: 0 },
    max_active_products: { type: Number, default: null, min: 0 },
    max_storage_bytes: { type: Number, default: null, min: 0 },
    commission_percent: { type: Number, default: null, min: 0, max: 100 },
    max_unterminated_shipments: { type: Number, default: null, min: 0 },
    max_cod_pool: { type: Number, default: null, min: 0 },
    live_tracking_enabled: { type: Boolean, default: true },
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
