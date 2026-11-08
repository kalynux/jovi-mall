/**
 * Seed: Pricing Plans (vendor + agency + agent)
 *
 * Idempotent upsert (by role + code) of every role's tiers. Safe to re-run; it
 * updates the seeded fields in place and never duplicates a plan. Editing a plan
 * afterwards via the admin API is fine — re-running resets the seeded fields, so
 * prefer the admin API for ongoing tweaks.
 *
 * For launch only the FREE tier of each role is active; the two paid tiers are
 * seeded `is_active: false` (defined, not yet purchasable) with placeholder
 * limits an admin can tune. Live tracking is enabled on every tier for now.
 *
 * ── Vendor plans come in two KINDS (SERVICE-LISTINGS-PLAN L-19, § Plans, § C-5) ──
 * Sellers keep `starter` / `growth` / `business`; service providers get `provider_free` /
 * `provider_plus` / `provider_pro` — listing slots instead of product slots, and no commission
 * (nothing is sold through Wi-Mall). Every vendor plan gets its `vendor_kind` WRITTEN, so a
 * re-run stamps `'seller'` on the seller plans seeded before the field existed; agency and agent
 * plans get `null`. Provider sort orders start at 11 so an unfiltered admin list keeps the two
 * kinds in two blocks.
 *
 * Importable without side effects: `main()` runs only when this file is the entry point,
 * because `test:service-listings-billing` imports `ALL_PLANS` to pin the L-19 numbers.
 *
 * Run:
 *   npm run seed:plans
 */
import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';

import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { freePlanCode } from '../../src/modules/billing/billing.types';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Every field the schema accepts; role-irrelevant limits are left null. */
export type SeedPlan = {
  role: 'vendor' | 'agency' | 'agent';
  code: string;
  name: string;
  price: number;
  currency: string;
  term_days: number | null;
  credit_allowance: number;
  max_active_products?: number | null;
  max_storage_bytes?: number | null;
  commission_percent?: number | null;
  max_unterminated_shipments?: number | null;
  max_cod_pool?: number | null;
  live_tracking_enabled?: boolean;
  /** Written on EVERY plan: the kind on a vendor plan, `null` on an agency or agent plan. */
  vendor_kind: 'seller' | 'provider' | null;
  /** Provider plans: listings occupying a slot. `null` everywhere else. */
  max_active_listings: number | null;
  is_active: boolean;
  sort_order: number;
};

// Credit allowances are deliberately hand-set per tier (not derived from price),
// then tunable per-plan via the admin API.
const VENDOR_PLANS: SeedPlan[] = [
  { role: 'vendor', vendor_kind: 'seller', code: freePlanCode('vendor', 'seller'), name: 'Starter', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 400, max_active_products: 80, max_storage_bytes: 5 * GB, commission_percent: 7, max_active_listings: null, is_active: true, sort_order: 1 },
  { role: 'vendor', vendor_kind: 'seller', code: 'growth', name: 'Growth', price: 7_500, currency: 'XAF', term_days: 30,
    credit_allowance: 900, max_active_products: 180, max_storage_bytes: 12 * GB, commission_percent: 6, max_active_listings: null, is_active: true, sort_order: 2 },
  { role: 'vendor', vendor_kind: 'seller', code: 'business', name: 'Business', price: 45_000, currency: 'XAF', term_days: 30,
    credit_allowance: 3_000, max_active_products: 600, max_storage_bytes: 40 * GB, commission_percent: 4, max_active_listings: null, is_active: true, sort_order: 3 },
];

// Service-provider tiers (SERVICE-LISTINGS-PLAN L-19 / § Plans — the numbers are the owner's).
// Credits are granted on each activation and never expire (Provider Free's 100 once: the free
// tier's allowance is a signup grant, never re-granted on a downgrade). Plan credits must be
// cheaper than the best top-up pack (~5.3 XAF/credit): Plus is ~5.0, Pro ~4.5. Storage is small
// because only photos are kept — a location video is a link the provider hosts. No products and
// no commission: nothing is sold through Wi-Mall.
const PROVIDER_PLANS: SeedPlan[] = [
  { role: 'vendor', vendor_kind: 'provider', code: freePlanCode('vendor', 'provider'), name: 'Provider Free', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 100, max_active_listings: 1, max_storage_bytes: 500 * MB, max_active_products: null, commission_percent: null, is_active: true, sort_order: 11 },
  { role: 'vendor', vendor_kind: 'provider', code: 'provider_plus', name: 'Provider Plus', price: 3_000, currency: 'XAF', term_days: 30,
    credit_allowance: 600, max_active_listings: 3, max_storage_bytes: 2 * GB, max_active_products: null, commission_percent: null, is_active: true, sort_order: 12 },
  { role: 'vendor', vendor_kind: 'provider', code: 'provider_pro', name: 'Provider Pro', price: 10_000, currency: 'XAF', term_days: 30,
    credit_allowance: 2_200, max_active_listings: 10, max_storage_bytes: 5 * GB, max_active_products: null, commission_percent: null, is_active: true, sort_order: 13 },
];

// Agency tiers. Free = 1000 unterminated shipments (soft cap). Paid tiers are
// defined but inactive for launch. Live tracking on for all (future free-tier gate).
// `max_storage_bytes` caps agency media (avatar/magazin branding + agent delivery
// proofs, which are charged to the agency's storage).
const AGENCY_PLANS: SeedPlan[] = [
  { role: 'agency', vendor_kind: null, max_active_listings: null, code: freePlanCode('agency'), name: 'Agency Free', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 50, max_unterminated_shipments: 1_000, max_storage_bytes: 5 * GB, live_tracking_enabled: true, is_active: true, sort_order: 1 },
  { role: 'agency', vendor_kind: null, max_active_listings: null, code: 'agency_growth', name: 'Agency Growth', price: 15_000, currency: 'XAF', term_days: 30,
    credit_allowance: 500, max_unterminated_shipments: 5_000, max_storage_bytes: 25 * GB, live_tracking_enabled: true, is_active: false, sort_order: 2 },
  { role: 'agency', vendor_kind: null, max_active_listings: null, code: 'agency_scale', name: 'Agency Scale', price: 50_000, currency: 'XAF', term_days: 30,
    credit_allowance: 2_000, max_unterminated_shipments: null /* unlimited */, max_storage_bytes: 100 * GB, live_tracking_enabled: true, is_active: false, sort_order: 3 },
];

// Agent tiers. Free = 20 unterminated deliveries (drives capacity.max_active_shipments).
// `max_storage_bytes` caps the agent's OWN media (an agent's delivery proofs count
// against the agency, not here).
// `max_cod_pool` is the COD cash a KYC-VERIFIED agent on the tier may carry across every
// agency (owner decision 2026-09-21: Free 500 000 · Plus 1 000 000 · Pro 2 000 000). An
// unverified agent's pool is 0 whatever the tier — `AgentCodPoolService` applies that rule,
// not the plan. ⚠ `null` here would mean NO COD, not unlimited.
const AGENT_PLANS: SeedPlan[] = [
  { role: 'agent', vendor_kind: null, max_active_listings: null, code: freePlanCode('agent'), name: 'Agent Free', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 20, max_unterminated_shipments: 20, max_storage_bytes: 1 * GB, max_cod_pool: 500_000, live_tracking_enabled: true, is_active: true, sort_order: 1 },
  { role: 'agent', vendor_kind: null, max_active_listings: null, code: 'agent_plus', name: 'Agent Plus', price: 2_000, currency: 'XAF', term_days: 30,
    credit_allowance: 150, max_unterminated_shipments: 50, max_storage_bytes: 3 * GB, max_cod_pool: 1_000_000, live_tracking_enabled: true, is_active: false, sort_order: 2 },
  { role: 'agent', vendor_kind: null, max_active_listings: null, code: 'agent_pro', name: 'Agent Pro', price: 5_000, currency: 'XAF', term_days: 30,
    credit_allowance: 400, max_unterminated_shipments: 100, max_storage_bytes: 10 * GB, max_cod_pool: 2_000_000, live_tracking_enabled: true, is_active: false, sort_order: 3 },
];

export const ALL_PLANS: ReadonlyArray<SeedPlan> = [...VENDOR_PLANS, ...PROVIDER_PLANS, ...AGENCY_PLANS, ...AGENT_PLANS];

/**
 * `--providers-only` (the service-listings deploy, 2026-11-08): INSERT the three provider plans
 * if they are missing and touch nothing else. A full run `$set`s every role's seeded fields, so
 * on a live database it would reset whatever an administrator tuned on the seller, agency and
 * agent plans — a deploy of a vendor feature must not move an agency's or an agent's plan.
 * `$setOnInsert` also means an existing provider plan an admin has edited is left alone. Seller
 * plans need no `vendor_kind` stamp: every reader uses `SELLER_PLAN_FILTER` (`$ne: 'provider'`).
 */
export function plansToSeed(argv: readonly string[]): { plans: ReadonlyArray<SeedPlan>; insertOnly: boolean } {
  return argv.includes('--providers-only')
    ? { plans: PROVIDER_PLANS, insertOnly: true }
    : { plans: ALL_PLANS, insertOnly: false };
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('[seed:plans] Connected to MongoDB');

  const { plans, insertOnly } = plansToSeed(process.argv.slice(2));
  if (insertOnly) console.log('[seed:plans] --providers-only: inserting missing provider plans, overwriting nothing');

  for (const plan of plans) {
    await PricingPlanModel.updateOne(
      { role: plan.role, code: plan.code, deletedAt: null },
      insertOnly ? { $setOnInsert: { ...plan, deletedAt: null } } : { $set: { ...plan, deletedAt: null } },
      { upsert: true }
    );
    console.log(
      `[seed:plans] Upserted ${plan.role}/${plan.code} (${plan.name}) — ` +
        `${plan.is_active ? 'active' : 'inactive'}, allowance ${plan.credit_allowance} cr` +
        (plan.vendor_kind ? `, kind ${plan.vendor_kind}` : '')
    );
  }

  await mongoose.disconnect();
  console.log('[seed:plans] Done');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[seed:plans] Failed:', err);
    process.exit(1);
  });
}
