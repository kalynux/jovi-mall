import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { VendorPlanService, vendorPlanService } from './vendor-plan.service';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';

export interface VendorEntitlements {
  planCode: string;
  /** Max active products, or `null` for unlimited. */
  maxActiveProducts: number | null;
  /** Max total product-media storage in bytes (excludes digital-product assets). */
  maxStorageBytes: number;
  commissionPercent: number;
}

/**
 * EntitlementService - resolves a vendor's plan-driven limits.
 *
 * Plans differ only by product cap and commission, so this is deliberately
 * small. WhatsApp/calendar/analytics/etc. are universal and are NOT gated here;
 * WhatsApp usage is guarded by credit balance instead (see CreditWalletService).
 */
export class EntitlementService {
  constructor(
    private readonly vendorPlans: VendorPlanService = vendorPlanService,
    private readonly planRepo: PricingPlanRepository = new PricingPlanRepository()
  ) {}

  async getEntitlements(vendorId: string): Promise<VendorEntitlements> {
    const active = await this.vendorPlans.getActivePlan(vendorId);
    const plan = await this.planRepo.findById(active.plan_id.toString());
    if (!plan) {
      throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Active plan could not be resolved');
    }
    return {
      planCode: plan.code,
      maxActiveProducts: plan.max_active_products,
      maxStorageBytes: plan.max_storage_bytes,
      commissionPercent: plan.commission_percent,
    };
  }

  /**
   * Throw `BILLING_LIMIT_EXCEEDED` when creating one more active product would
   * exceed the plan cap. `currentActiveCount` is the vendor's existing count.
   */
  async assertCanAddProduct(vendorId: string, currentActiveCount: number): Promise<void> {
    const { maxActiveProducts, planCode } = await this.getEntitlements(vendorId);
    if (maxActiveProducts === null) return; // unlimited
    if (currentActiveCount >= maxActiveProducts) {
      throw createAppError(
        ERROR_CODES.BILLING_LIMIT_EXCEEDED,
        403,
        `Your '${planCode}' plan allows up to ${maxActiveProducts} active products. Upgrade to add more.`,
        { limit: maxActiveProducts, current: currentActiveCount }
      );
    }
  }
}

export const entitlementService = new EntitlementService();
