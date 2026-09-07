import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../../billing/billing.types';

/**
 * PlanQuotaState — what the owner's current suspension/blocking set was computed FOR.
 *
 * ── Why this collection exists, and why it is not an outbox ──────────────────────
 * Enforcement has to happen when a plan changes, and the obvious hook — the
 * `plan.activated` domain event — is published on the **in-memory, per-process,
 * no-retry** bus whose `publish` swallows handler errors (`core/events/event-bus.ts`).
 * CLAUDE.md is explicit that durable state must not depend on it, and the failure here
 * would be both silent and permanent: one dropped event leaves a vendor on the free tier
 * with a hundred live products and nothing anywhere to notice.
 *
 * The usual remedy is an outbox row written inside the producing transaction. That is
 * not needed here, because **the authority is already committed transactionally** — the
 * `subscriber_plans` row. So instead of recording an *instruction* that could be lost,
 * this records the *conclusion*: which plan, and which limit values, the current set of
 * suspensions was derived from. A sweep then compares that against the live active plan
 * and recomputes wherever they disagree. Nothing can be lost, because nothing is queued;
 * the worst case of a dropped event is one cron interval of staleness.
 *
 * ⚠ **The limit VALUES are stamped, not just `enforced_plan_id`, and that is not
 * belt-and-braces.** An administrator editing a live plan through
 * `PATCH /api/internal/admin/billing/plans/:id` changes `max_active_products` on the
 * plan every subscriber already points at — the `plan_id` on every `subscriber_plans`
 * row is unchanged, and `PricingPlanService.update` emits no event at all. Comparing ids
 * alone would miss every such edit, which is precisely the case where a limit gets
 * *tightened* for an entire tier at once.
 *
 * The counters are reporting only. They are what the sweep last did, not a source of
 * truth — the truth is `Product.suspension.reason` and `File.quotaBlockedAt`, and a
 * recompute always re-derives from those rather than from anything stored here.
 */
export interface IPlanQuotaState extends Document {
    owner_type: BillingOwnerType;
    owner_id: Types.ObjectId;

    /** The active plan this owner's suspension set was computed against. */
    enforced_plan_id: Types.ObjectId | null;
    /** `null` = unlimited, and distinct from `0` = none allowed. */
    enforced_max_products: number | null;
    enforced_max_storage_bytes: number | null;

    enforced_at: Date;

    // ── Reporting only — never read back as input ────────────────────────────────
    products_suspended: number;
    files_blocked: number;
    bytes_blocked: number;

    created_at: Date;
    updated_at: Date;
}

const PlanQuotaStateSchema = new Schema<IPlanQuotaState>(
    {
        owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
        owner_id: { type: Schema.Types.ObjectId, required: true },

        enforced_plan_id: { type: Schema.Types.ObjectId, default: null },
        enforced_max_products: { type: Number, default: null },
        enforced_max_storage_bytes: { type: Number, default: null },

        enforced_at: { type: Date, required: true },

        products_suspended: { type: Number, default: 0, min: 0 },
        files_blocked: { type: Number, default: 0, min: 0 },
        bytes_blocked: { type: Number, default: 0, min: 0 },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// One row per owner. Unique rather than merely indexed: two rows would let two sweeps
// each believe they had enforced the current plan while disagreeing about which one it is.
PlanQuotaStateSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export const PlanQuotaStateModel = mongoose.model<IPlanQuotaState>(
    MODELS.PLAN_QUOTA_STATE,
    PlanQuotaStateSchema,
    COLLECTIONS.PLAN_QUOTA_STATE
);
