import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { SubscriberPlanService, subscriberPlanService } from './subscriber-plan.service';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { BillingOwnerType } from '../billing.types';
import { IPricingPlan } from '../models/pricing-plan.model';

export interface VendorEntitlements {
  planCode: string;
  /** Max active products, or `null` for unlimited. */
  maxActiveProducts: number | null;
  /** Max total product-media storage in bytes (excludes digital-product assets). */
  maxStorageBytes: number;
  commissionPercent: number;
}

export interface ShipmentPlanEntitlements {
  planCode: string;
  /** Max unterminated shipments the owner may hold, or `null` for unlimited. */
  maxUnterminatedShipments: number | null;
  /** Whether live tracking is available on this plan (universal today). */
  liveTrackingEnabled: boolean;
}

/** Fallback storage cap when a (mis-seeded) plan omits `max_storage_bytes`. */
const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024;

/**
 * EntitlementService - resolves an owner's plan-driven limits.
 *
 * Vendor limits (products/storage/commission) and agency/agent limits
 * (unterminated-shipment cap, live tracking) are read from the same active-plan
 * lookup, differing only by role. WhatsApp/calendar/analytics remain universal
 * and are guarded by credit balance instead of a plan gate.
 */
export class EntitlementService {
  constructor(
    private readonly plans: SubscriberPlanService = subscriberPlanService,
    private readonly planRepo: PricingPlanRepository = new PricingPlanRepository()
  ) {}

  private async getActivePricingPlan(ownerType: BillingOwnerType, ownerId: string): Promise<IPricingPlan> {
    const active = await this.plans.getActivePlan(ownerType, ownerId);
    const plan = await this.planRepo.findById(active.plan_id.toString());
    if (!plan) {
      throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Active plan could not be resolved');
    }
    return plan;
  }

  // ── Storage (all owner types) ────────────────────────────────────────────────

  /**
   * Resolve the plan-driven media-storage cap (bytes) for any owner type. Every
   * role's plans now carry `max_storage_bytes`; a (mis-seeded) plan that omits it
   * falls back to `DEFAULT_MAX_STORAGE_BYTES`. Used by the file storage summary
   * and the upload quota context for vendor, agency and agent alike.
   */
  async resolveMaxStorageBytes(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
    const plan = await this.getActivePricingPlan(ownerType, ownerId);
    return plan.max_storage_bytes ?? DEFAULT_MAX_STORAGE_BYTES;
  }

  // ── Vendor ──────────────────────────────────────────────────────────────────

  async getEntitlements(vendorId: string): Promise<VendorEntitlements> {
    const plan = await this.getActivePricingPlan('vendor', vendorId);
    return {
      planCode: plan.code,
      maxActiveProducts: plan.max_active_products,
      maxStorageBytes: plan.max_storage_bytes ?? DEFAULT_MAX_STORAGE_BYTES,
      commissionPercent: plan.commission_percent ?? 0,
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

  // ── Agency / agent (shipment-cap + live tracking) ────────────────────────────

  async getShipmentEntitlements(
    ownerType: BillingOwnerType,
    ownerId: string
  ): Promise<ShipmentPlanEntitlements> {
    const plan = await this.getActivePricingPlan(ownerType, ownerId);
    return {
      planCode: plan.code,
      maxUnterminatedShipments: plan.max_unterminated_shipments,
      liveTrackingEnabled: plan.live_tracking_enabled,
    };
  }

  /**
   * Whether live tracking is currently available for this owner. Returns `true`
   * for every seeded plan today; kept as the single check-site so a future
   * free-tier restriction is a plan/data change, not new call-sites.
   */
  async isLiveTrackingEnabled(ownerType: BillingOwnerType, ownerId: string): Promise<boolean> {
    const { liveTrackingEnabled } = await this.getShipmentEntitlements(ownerType, ownerId);
    return liveTrackingEnabled;
  }
}

export const entitlementService = new EntitlementService();
