import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { IPricingPlan, PlanRole } from '../models/pricing-plan.model';
import type { VendorKind } from '../../vendors/domain/vendor-kind';

export interface CreatePlanInput {
  role: PlanRole;
  code: string;
  name: string;
  price: number;
  currency?: string;
  term_days: number | null;
  credit_allowance: number;
  max_active_products?: number | null;
  max_storage_bytes?: number | null;
  commission_percent?: number | null;
  max_unterminated_shipments?: number | null;
  max_cod_pool?: number | null;
  live_tracking_enabled?: boolean;
  is_active?: boolean;
  sort_order?: number;
  /** Vendor plans only (SERVICE-LISTINGS-PLAN § C-5). Absent/null on a vendor plan = seller. */
  vendor_kind?: VendorKind | null;
  /** Provider plans: listing slots (`null` = unlimited). */
  max_active_listings?: number | null;
}

/**
 * The plan fields whose value is COPIED onto owners rather than read live, so an
 * in-place edit of one of them must be pushed. `max_unterminated_shipments` is
 * deliberately absent: its copy (`capacity.max_active_shipments`) has never
 * followed an in-place edit, and changing that is a separate decision.
 */
const PUSHED_ON_EDIT: ReadonlyArray<keyof CreatePlanInput> = ['max_cod_pool'];

/** Admin-side management + read access for the pricing plan catalog. */
export class PricingPlanService {
  constructor(private readonly repo: PricingPlanRepository = new PricingPlanRepository()) {}

  async listForRole(role: PlanRole, activeOnly: boolean): Promise<IPricingPlan[]> {
    return this.repo.list(role, activeOnly);
  }

  /**
   * The vendor plans of ONE kind (SERVICE-LISTINGS-PLAN § C-5) — what a vendor is offered.
   * A seller never sees a provider plan and the reverse; assigning across kinds is refused
   * anyway (`assertPlanServesOwner`), so listing one would be a button that always fails.
   */
  async listForVendorKind(vendorKind: VendorKind, activeOnly: boolean): Promise<IPricingPlan[]> {
    return this.repo.list('vendor', activeOnly, vendorKind);
  }

  async getById(id: string): Promise<IPricingPlan> {
    const plan = await this.repo.findById(id);
    if (!plan) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
    return plan;
  }

  async create(input: CreatePlanInput): Promise<IPricingPlan> {
    const existing = await this.repo.findByCode(input.role, input.code);
    if (existing) {
      throw createAppError(
        ERROR_CODES.BILLING_PLAN_CODE_EXISTS,
        409,
        `A ${input.role} plan with code '${input.code}' already exists`
      );
    }
    // The kind belongs to vendor plans alone (§ C-5): an agency or agent plan carries null.
    const vendorKind = input.role === 'vendor' ? (input.vendor_kind ?? null) : null;
    return this.repo.create({ ...input, vendor_kind: vendorKind });
  }

  async update(id: string, updates: Partial<CreatePlanInput>): Promise<IPricingPlan> {
    // `code`/`role` are immutable once created to keep assignments stable — and so is
    // `vendor_kind` (§ C-5), for the same reason: flipping a plan's kind in place would move
    // every subscriber on it to a plan of the other kind (a seller suddenly on listing slots).
    delete (updates as Record<string, unknown>).code;
    delete (updates as Record<string, unknown>).role;
    delete (updates as Record<string, unknown>).vendor_kind;
    const before = await this.repo.findById(id);
    const plan = await this.repo.update(id, updates);
    if (!plan) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');

    // `plan.activated` does not fire for an in-place edit — no owner changed plan — so
    // a value copied onto owners would otherwise go stale until the nightly reconcile.
    // Post-commit and fire-and-forget: the edit has landed whatever a consumer does.
    const changed = PUSHED_ON_EDIT.filter(
      (field) => updates[field] !== undefined && (before?.[field] ?? null) !== (plan[field] ?? null)
    );
    if (changed.length > 0) {
      void eventBus
        .publish('pricing_plan.updated', {
          eventType: 'pricing_plan.updated',
          aggregateId: plan._id.toString(),
          occurredAt: new Date(),
          payload: { planId: plan._id.toString(), role: plan.role, code: plan.code, changed },
        })
        .catch((err) => console.error('[PricingPlanService] plan-updated emit failed:', err));
    }
    return plan;
  }

  async remove(id: string): Promise<void> {
    const ok = await this.repo.softDelete(id);
    if (!ok) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
  }
}

export const pricingPlanService = new PricingPlanService();
