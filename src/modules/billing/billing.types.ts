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
 */
export const FREE_PLAN_CODE_BY_ROLE: Readonly<Record<BillingOwnerType, string>> = {
  vendor: 'starter',
  agency: 'agency_free',
  agent: 'agent_free',
};

export function freePlanCode(role: BillingOwnerType): string {
  return FREE_PLAN_CODE_BY_ROLE[role];
}
