import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
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
  live_tracking_enabled?: boolean;
  is_active?: boolean;
  sort_order?: number;
}

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
    const plan = await this.repo.update(id, updates);
    if (!plan) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
    return plan;
  }

  async remove(id: string): Promise<void> {
    const ok = await this.repo.softDelete(id);
    if (!ok) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
  }
}

export const pricingPlanService = new PricingPlanService();
