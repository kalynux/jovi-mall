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

  // ── The administrative read ──────────────────────────────────────────────────

  /**
   * Every plan-driven limit for one owner, in one answer — what wi-admin's account
   * surface renders. The two methods above answer half each and both resolve the same
   * plan, so an admin view asking for both would load it twice.
   *
   * ── This one does NOT create a plan, and that is the whole reason it exists ───
   * `getActivePlan` lazily creates the role's free tier and grants its credit
   * allowance the first time an owner has none. That is correct when the OWNER is
   * asking — the grant is theirs and the first read is effectively signup. It is wrong
   * when an ADMINISTRATOR is asking: browsing a list of accounts would materialise a
   * subscriber_plans row and a credit grant for every owner an operator happened to
   * open, and wi-admin's whole data model rests on reads not mutating this database.
   *
   * So this reads the active row and reports `null` when there is none, leaving the
   * grant to happen when the owner turns up. An owner with no active plan is a real,
   * renderable state — "never subscribed" — not an error and not a reason to write.
   */
  async getAdminEntitlements(
    ownerType: BillingOwnerType,
    ownerId: string
  ): Promise<{
    planCode: string | null;
    maxActiveProducts: number | null;
    maxStorageBytes: number | null;
    commissionPercent: number | null;
    maxUnterminatedShipments: number | null;
    liveTrackingEnabled: boolean | null;
  }> {
    const active = await this.plans.findActivePlanWithoutCreating(ownerType, ownerId);
    const plan = active ? await this.planRepo.findById(active.plan_id.toString()) : null;

    if (!plan) {
      return {
        planCode: null,
        maxActiveProducts: null,
        maxStorageBytes: null,
        commissionPercent: null,
        maxUnterminatedShipments: null,
        liveTrackingEnabled: null,
      };
    }

    return {
      planCode: plan.code,
      maxActiveProducts: plan.max_active_products,
      maxStorageBytes: plan.max_storage_bytes ?? DEFAULT_MAX_STORAGE_BYTES,
      commissionPercent: plan.commission_percent ?? 0,
      maxUnterminatedShipments: plan.max_unterminated_shipments,
      liveTrackingEnabled: plan.live_tracking_enabled,
    };
  }
}

export const entitlementService = new EntitlementService();
