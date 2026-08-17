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
 * Run:
 *   npm run seed:plans
 */
import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';

import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { freePlanCode } from '../../src/modules/billing/billing.types';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const GB = 1024 * 1024 * 1024;

/** Every field the schema accepts; role-irrelevant limits are left null. */
type SeedPlan = {
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
  live_tracking_enabled?: boolean;
  is_active: boolean;
  sort_order: number;
};

// Credit allowances are deliberately hand-set per tier (not derived from price),
// then tunable per-plan via the admin API.
const VENDOR_PLANS: SeedPlan[] = [
  { role: 'vendor', code: freePlanCode('vendor'), name: 'Starter', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 50, max_active_products: 15, max_storage_bytes: 1 * GB, commission_percent: 7, is_active: true, sort_order: 1 },
  { role: 'vendor', code: 'growth', name: 'Growth', price: 5_000, currency: 'XAF', term_days: 30,
    credit_allowance: 850, max_active_products: 150, max_storage_bytes: 10 * GB, commission_percent: 5, is_active: true, sort_order: 2 },
  { role: 'vendor', code: 'business', name: 'Business', price: 25_000, currency: 'XAF', term_days: 30,
    credit_allowance: 4_500, max_active_products: null, max_storage_bytes: 100 * GB, commission_percent: 3, is_active: true, sort_order: 3 },
];

// Agency tiers. Free = 1000 unterminated shipments (soft cap). Paid tiers are
// defined but inactive for launch. Live tracking on for all (future free-tier gate).
// `max_storage_bytes` caps agency media (avatar/magazin branding + agent delivery
// proofs, which are charged to the agency's storage).
const AGENCY_PLANS: SeedPlan[] = [
  { role: 'agency', code: freePlanCode('agency'), name: 'Agency Free', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 50, max_unterminated_shipments: 1_000, max_storage_bytes: 5 * GB, live_tracking_enabled: true, is_active: true, sort_order: 1 },
  { role: 'agency', code: 'agency_growth', name: 'Agency Growth', price: 15_000, currency: 'XAF', term_days: 30,
    credit_allowance: 500, max_unterminated_shipments: 5_000, max_storage_bytes: 25 * GB, live_tracking_enabled: true, is_active: false, sort_order: 2 },
  { role: 'agency', code: 'agency_scale', name: 'Agency Scale', price: 50_000, currency: 'XAF', term_days: 30,
    credit_allowance: 2_000, max_unterminated_shipments: null /* unlimited */, max_storage_bytes: 100 * GB, live_tracking_enabled: true, is_active: false, sort_order: 3 },
];

// Agent tiers. Free = 20 unterminated deliveries (drives capacity.max_active_shipments).
// `max_storage_bytes` caps the agent's OWN media (an agent's delivery proofs count
// against the agency, not here).
const AGENT_PLANS: SeedPlan[] = [
  { role: 'agent', code: freePlanCode('agent'), name: 'Agent Free', price: 0, currency: 'XAF', term_days: null,
    credit_allowance: 20, max_unterminated_shipments: 20, max_storage_bytes: 1 * GB, live_tracking_enabled: true, is_active: true, sort_order: 1 },
  { role: 'agent', code: 'agent_plus', name: 'Agent Plus', price: 2_000, currency: 'XAF', term_days: 30,
    credit_allowance: 150, max_unterminated_shipments: 50, max_storage_bytes: 3 * GB, live_tracking_enabled: true, is_active: false, sort_order: 2 },
  { role: 'agent', code: 'agent_pro', name: 'Agent Pro', price: 5_000, currency: 'XAF', term_days: 30,
    credit_allowance: 400, max_unterminated_shipments: 100, max_storage_bytes: 10 * GB, live_tracking_enabled: true, is_active: false, sort_order: 3 },
];

const ALL_PLANS: SeedPlan[] = [...VENDOR_PLANS, ...AGENCY_PLANS, ...AGENT_PLANS];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('[seed:plans] Connected to MongoDB');

  for (const plan of ALL_PLANS) {
    await PricingPlanModel.updateOne(
      { role: plan.role, code: plan.code, deletedAt: null },
      { $set: { ...plan, deletedAt: null } },
      { upsert: true }
    );
    console.log(
      `[seed:plans] Upserted ${plan.role}/${plan.code} (${plan.name}) — ` +
        `${plan.is_active ? 'active' : 'inactive'}, allowance ${plan.credit_allowance} cr`
    );
  }

  await mongoose.disconnect();
  console.log('[seed:plans] Done');
}

run().catch((err) => {
  console.error('[seed:plans] Failed:', err);
  process.exit(1);
});
