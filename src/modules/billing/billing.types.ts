/**
 * Billing owner/role types.
 *
 * A single discriminator spans the whole billing engine: the credit wallet, the
 * ledger, the pricing-plan catalog (`PricingPlan.role`) and the plan-assignment
 * record (`SubscriberPlan.owner_type`) all key on the SAME set of roles, so a
 * plan, its wallet and its allowance always agree on who they belong to.
 *
 * `WalletOwnerType` and `PlanRole` are kept as named aliases (imported widely)
 * but are deliberately identical — a plan's role IS its wallet's owner type.
 */
export type BillingOwnerType = 'vendor' | 'agency' | 'agent';

/**
 * All billing owner types, for schema enums, Zod enums and iteration (seed, expiry sweep).
 *
 * Deliberately NOT annotated `readonly BillingOwnerType[]`. That annotation widens the
 * literal tuple back to a plain array, which costs the two things this constant exists to
 * give: `z.enum([...BILLING_OWNER_TYPES])` cannot infer its members, and a validator
 * derived from it degrades to `string` — so a schema meant to accept exactly these three
 * silently accepts anything, and the drift the shared list was preventing comes back in
 * through the validator instead.
 */
export const BILLING_OWNER_TYPES = ['vendor', 'agency', 'agent'] as const satisfies readonly BillingOwnerType[];

/**
 * The free, never-expiring default tier code per role. Every owner falls back to
 * this when they have no active plan (lazily created on first read).
 *
 * `vendor` here is the SELLER free tier. A provider vendor (SERVICE-LISTINGS-PLAN L-19,
 * § C-5) has its own, `PROVIDER_FREE_PLAN_CODE` — read both through `freePlanCode`.
 */
export const FREE_PLAN_CODE_BY_ROLE: Readonly<Record<BillingOwnerType, string>> = {
  vendor: 'starter',
  agency: 'agency_free',
  agent: 'agent_free',
};

/** The free tier of a PROVIDER vendor (§ C-5). Sellers keep `starter`. */
export const PROVIDER_FREE_PLAN_CODE = 'provider_free';

/**
 * The free tier an owner falls back to — per role AND, for a vendor, per kind.
 *
 * ⚠ **Every caller acting for a vendor must pass the vendor's kind** (`vendorKindOf` on the
 * vendor row; `resolveOwnerVendorKind` in billing). Omitting it answers the SELLER tier, which
 * is right for the seed scripts that only ever seed sellers and wrong anywhere a provider can
 * reach: a provider lazily put on `starter` gets a seller's allowance, products and commission
 * and no listing slot at all. `test:service-listings-billing` refuses a one-argument call in `src/`.
 */
export function freePlanCode(role: BillingOwnerType, vendorKind?: 'seller' | 'provider' | null): string {
  if (role === 'vendor' && vendorKind === 'provider') return PROVIDER_FREE_PLAN_CODE;
  return FREE_PLAN_CODE_BY_ROLE[role];
}

/** Every free-tier code a role has — both vendor kinds for `vendor`. For "is this a paid plan?" reads. */
export function freePlanCodesForRole(role: BillingOwnerType): string[] {
  return role === 'vendor' ? [FREE_PLAN_CODE_BY_ROLE.vendor, PROVIDER_FREE_PLAN_CODE] : [FREE_PLAN_CODE_BY_ROLE[role]];
}
