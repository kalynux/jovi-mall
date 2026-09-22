import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { SubscriberPlanService, subscriberPlanService } from './subscriber-plan.service';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { BillingOwnerType, freePlanCode } from '../billing.types';
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

/** What an agent's plan says about their COD pool — see `resolveAgentCodPool`. */
export interface AgentCodPoolEntitlement {
  /** The plan the value came from; `null` only when no agent plan is configured at all. */
  planCode: string | null;
  /** `plan.max_cod_pool ?? 0` — ⚠ an unset value is ZERO, never unlimited. */
  maxCodPool: number;
  /**
   * `false` when the agent holds no `subscriber_plans` row yet and the free tier's
   * catalog value was read instead. Same number the lazy creation would produce;
   * reported so a caller can say "free tier (not yet activated)" if it wants to.
   */
  assigned: boolean;
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
    return this.assertCanAddProducts(vendorId, currentActiveCount, 1);
  }

  /**
   * The same gate for a batch — `adding` more catalog slots on top of
   * `currentActiveCount`.
   *
   * ⚠ **Bulk paths must use this rather than looping the single-product version**, and
   * the reason is that the single version is a *threshold* test, not an arithmetic one:
   * called once per item against an unchanged `currentActiveCount`, it answers "is there
   * room for one more?" identically for every item in the batch, so a vendor with one
   * free slot un-archives fifty products and every check passes. The count only moves
   * after the write.
   *
   * The refusal is all-or-nothing rather than partial. A bulk status change that
   * silently applied to the first N and skipped the rest would report success for an
   * operation the vendor cannot see the shape of; `details` carries the numbers so a
   * dashboard can say exactly how many slots are free.
   */
  async assertCanAddProducts(vendorId: string, currentActiveCount: number, adding: number): Promise<void> {
    if (adding <= 0) return;
    const { maxActiveProducts, planCode } = await this.getEntitlements(vendorId);
    if (maxActiveProducts === null) return; // unlimited
    if (currentActiveCount + adding > maxActiveProducts) {
      const available = Math.max(0, maxActiveProducts - currentActiveCount);
      throw createAppError(
        ERROR_CODES.BILLING_LIMIT_EXCEEDED,
        403,
        adding === 1
          ? `Your '${planCode}' plan allows up to ${maxActiveProducts} products. Upgrade to add more.`
          : `Your '${planCode}' plan allows up to ${maxActiveProducts} products, and you have room for ${available} more. Upgrade, or archive some first.`,
        { limit: maxActiveProducts, current: currentActiveCount, requested: adding, available }
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

  // ── Agent COD pool ───────────────────────────────────────────────────────────

  /**
   * The COD pool an agent's plan grants — the INPUT to the agent's pool, not the pool
   * itself (that also depends on their KYC verdict and any administrator override, and
   * is resolved in the agents module by `AgentCodPoolService`).
   *
   * ── It never creates a plan ─────────────────────────────────────────────────────
   * `findActivePlanWithoutCreating`, for the reason `getAdminEntitlements` below gives:
   * this is read by a KYC verdict and by a nightly sweep over every agent, and neither
   * may mint a `subscriber_plans` row and a credit grant for an agent who has never
   * opened their billing screen.
   *
   * ── …but, unlike plan-quota, it does not SKIP a plan-less owner ─────────────────
   * An agent with no row is on the free tier in every sense but the row — the first
   * read of their plan will create exactly that tier. So the free tier's CATALOG value
   * applies. Skipping them (plan-quota's choice, right for a quota that only ever takes
   * things away) would leave every newly verified agent at a pool of 0 until they
   * happened to open billing, which is the opposite of "set automatically".
   *
   * An active row pointing at a plan that no longer resolves falls back the same way.
   * No free tier configured at all answers 0 — fail closed, this is cash.
   */
  async resolveAgentCodPool(agentId: string): Promise<AgentCodPoolEntitlement> {
    const active = await this.plans.findActivePlanWithoutCreating('agent', agentId);
    const assignedPlan = active ? await this.planRepo.findById(active.plan_id.toString()) : null;
    if (assignedPlan) {
      return { planCode: assignedPlan.code, maxCodPool: assignedPlan.max_cod_pool ?? 0, assigned: true };
    }

    const free = await this.planRepo.findByCode('agent', freePlanCode('agent'));
    return free
      ? { planCode: free.code, maxCodPool: free.max_cod_pool ?? 0, assigned: false }
      : { planCode: null, maxCodPool: 0, assigned: false };
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
    /** Agent plans only — `null` for other roles and for "never subscribed". */
    maxCodPool: number | null;
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
        maxCodPool: null,
        liveTrackingEnabled: null,
      };
    }

    return {
      planCode: plan.code,
      maxActiveProducts: plan.max_active_products,
      maxStorageBytes: plan.max_storage_bytes ?? DEFAULT_MAX_STORAGE_BYTES,
      commissionPercent: plan.commission_percent ?? 0,
      maxUnterminatedShipments: plan.max_unterminated_shipments,
      // `?? 0` on an agent plan for the same fail-closed reason as `resolveAgentCodPool`.
      maxCodPool: ownerType === 'agent' ? (plan.max_cod_pool ?? 0) : null,
      liveTrackingEnabled: plan.live_tracking_enabled,
    };
  }
}

export const entitlementService = new EntitlementService();
