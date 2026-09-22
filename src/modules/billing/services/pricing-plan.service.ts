import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { IPricingPlan, PlanRole } from '../models/pricing-plan.model';

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
    return this.repo.create(input);
  }

  async update(id: string, updates: Partial<CreatePlanInput>): Promise<IPricingPlan> {
    // `code`/`role` are immutable once created to keep assignments stable.
    delete (updates as Record<string, unknown>).code;
    delete (updates as Record<string, unknown>).role;
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
