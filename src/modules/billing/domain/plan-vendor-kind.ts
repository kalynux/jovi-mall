/**
 * Which vendor KIND a pricing plan serves (SERVICE-LISTINGS-PLAN L-19, § C-5, § Plans).
 *
 * A seller and a provider are both `role: 'vendor'` and share one wallet, one billing router
 * and one plan catalog collection — but not one set of plans. A seller plan sells products and
 * takes a commission; a provider plan grants listing slots and takes none. Putting a provider on
 * `growth` would hand them product slots they cannot use and no listing slot at all.
 *
 * ⚠ **`vendor_kind` is MISSING on every vendor plan seeded before 2026-10-19, and missing means
 * SELLER** — the same rule `vendorKindOf` applies to vendors. So:
 *   - READ a plan's kind through `planVendorKindOf()`, never `plan.vendor_kind === 'seller'`;
 *   - QUERY seller plans with `SELLER_PLAN_FILTER` (`$ne: 'provider'`), never `'seller'`.
 *
 * Pure: imports nothing but the error factory, so the DB-free suite can drive every rule.
 */
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import type { VendorKind } from '../../vendors/domain/vendor-kind';
import type { BillingOwnerType } from '../billing.types';

/** Anything shaped like a plan, as far as its kind is concerned. */
export interface PlanKindShape {
  role?: string;
  vendor_kind?: unknown;
}

/**
 * The kind a plan serves: `'provider'` / `'seller'` for a vendor plan, `null` for an agency or
 * agent plan. A vendor plan with no value (or an unknown one) is a SELLER plan.
 */
export function planVendorKindOf(plan: PlanKindShape | null | undefined): VendorKind | null {
  if (!plan || plan.role !== 'vendor') return null;
  return plan.vendor_kind === 'provider' ? 'provider' : 'seller';
}

/**
 * May an owner of `ownerType` (and, for a vendor, `vendorKind`) hold this plan?
 *
 * Role first — an agency plan is never a vendor's. Then, for a vendor, the kind; a vendor whose
 * kind is unknown is a seller, as everywhere.
 */
export function planServesOwner(
  plan: PlanKindShape,
  ownerType: BillingOwnerType,
  vendorKind: VendorKind | null,
): boolean {
  if (plan.role !== ownerType) return false;
  if (ownerType !== 'vendor') return true;
  return planVendorKindOf(plan) === (vendorKind ?? 'seller');
}

/**
 * Refuse a plan the owner may not hold — the role check `assignPlan` and `initiatePurchase`
 * already made, widened to the vendor kind.
 *
 * ⚠ **The SAME code at the SAME status as the role mismatch (`409 BILLING_PLAN_ROLE_MISMATCH`)**,
 * deliberately rather than a new code: a provider plan is "a plan for another kind of owner",
 * which is exactly what that code already says to a client, and `test:errors`' census refuses
 * one code at two statuses. `details.required` names what the plan is for, so a dashboard can
 * say it without guessing.
 */
export function assertPlanServesOwner(
  plan: PlanKindShape,
  ownerType: BillingOwnerType,
  vendorKind: VendorKind | null,
): void {
  if (plan.role !== ownerType) {
    throw createAppError(ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH, 409, `Plan does not belong to the ${ownerType} role`);
  }
  if (!planServesOwner(plan, ownerType, vendorKind)) {
    const planKind = planVendorKindOf(plan);
    throw createAppError(
      ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH,
      409,
      planKind === 'provider'
        ? 'This plan is for service providers. Pick one of the seller plans.'
        : 'This plan is for sellers. Pick one of the service provider plans.',
      { required: planKind },
    );
  }
}

/** Mongo filter for SELLER vendor plans — correct for plans seeded with no `vendor_kind`. */
export const SELLER_PLAN_FILTER = Object.freeze({ vendor_kind: { $ne: 'provider' } });

/** Mongo filter for PROVIDER vendor plans (they always carry the field — the seed writes it). */
export const PROVIDER_PLAN_FILTER = Object.freeze({ vendor_kind: 'provider' });

/** The Mongo filter narrowing a vendor plan list to one kind. */
export function vendorPlanKindFilter(kind: VendorKind): Readonly<Record<string, unknown>> {
  return kind === 'provider' ? PROVIDER_PLAN_FILTER : SELLER_PLAN_FILTER;
}
