/**
 * test:service-listings-billing — informational service listings, the BILLING half of wave 1
 * (walk-order step 2 + the wallet half of step 6). DB-free.
 *
 * Plan: PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md — L-10, L-11, L-12, L-19, O-16, § Plans,
 * § C-5, § C-8a.
 *
 *   § 1  the provider plans — the L-19 numbers, and seller / agency / agent plans' kinds
 *   § 2  the free plan per role AND kind, and every free-plan fallback resolving the kind
 *   § 3  a plan's kind: the read helper, the filter, the refusal across kinds, the public DTO,
 *        the admin validators
 *   § 4  the wallet debt rules — the floor, the schema without `min: 0`, a credit pays debt first
 *   § 5  ⛔ `debitAllowingDebt` has ONE caller outside billing (the listing reveal)
 *   § 6  ⛔ every credit path publishes `billing.wallet.credited`, post-commit
 *   § 7  role closure — the debt warning, the write-off, the listings archived and contacts erased
 *   § 8  the listing quota on a downgrade (O-16) — the cut-off, the restore, the sweep wiring
 *   § 9  the public costs payload
 *   § 10 the transactions feed labels the three new reason codes
 *
 * Every ⛔ guard here was mutation-proven when written: break the guarded line, watch the named
 * assertion fail, restore it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import { ALL_PLANS, SeedPlan } from '../seed/seed-pricing-plans';
import {
  FREE_PLAN_CODE_BY_ROLE,
  PROVIDER_FREE_PLAN_CODE,
  freePlanCode,
  freePlanCodesForRole,
} from '../../src/modules/billing/billing.types';
import {
  planVendorKindOf,
  planServesOwner,
  assertPlanServesOwner,
  vendorPlanKindFilter,
  SELLER_PLAN_FILTER,
} from '../../src/modules/billing/domain/plan-vendor-kind';
import { wouldStayAboveFloor, debtFloorFilter, debtToWriteOff } from '../../src/modules/billing/domain/wallet-debt';
import {
  WALLET_CREDITED_EVENT,
  walletCreditedPayload,
  publishWalletCredited,
} from '../../src/modules/billing/domain/wallet-credited.event';
import { CreditWalletModel } from '../../src/modules/billing/models/credit-wallet.model';
import { CreditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { SubscriberPlanService } from '../../src/modules/billing/services/subscriber-plan.service';
import { PlanPurchaseService } from '../../src/modules/billing/services/plan-purchase.service';
import { toPublicPlanDto } from '../../src/modules/billing/dto/public-plan.dto';
import {
  CreatePlanSchema,
  UpdatePlanSchema,
  PublicListPlansQuerySchema,
} from '../../src/modules/billing/validators/billing.validators';
import { PublicBillingController } from '../../src/modules/billing/controllers/public-billing.controller';
import {
  CREDIT_TOPUP_PACKS,
  LISTING_REVEAL_FIRST_COST,
  LISTING_REVEAL_NEXT_COST,
} from '../../src/modules/billing/config/credit.config';
import { eventBus } from '../../src/core/events/event-bus';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ROLE_CLOSURE_WARNING_CODES } from '../../src/modules/role-closure/role-closure.types';
import { creditWarningsFor } from '../../src/modules/role-closure/services/role-closure-blockers.service';
import {
  occupiesListingSlot,
  toListingQuotaCandidate,
  listingRestoreTarget,
  ListingSlot,
  LISTING_QUOTA_REASON,
} from '../../src/modules/plan-quota/domain/listing-quota';
import { planCountCutoff } from '../../src/modules/plan-quota/domain/quota-cutoff';
import { CREDIT_TYPE_BY_REASON, CREDIT_DESC_BY_REASON } from '../../src/modules/transactions/services/vendor-transaction.service';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * Drop comments so a header that QUOTES a guard cannot satisfy the scan. A character walk that
 * honours string literals — the same one `test:service-listings` uses, for its reason.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const code = (relPath: string): string => stripComments(read(relPath));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** The text of a method, from its signature to the next method at the same indentation. */
function methodSpan(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const rest = src.slice(start + signature.length);
  // A top-level function ends at its closing brace; a method at the next method or the class's end.
  if (/^export (async )?function /.test(signature)) {
    const end = rest.indexOf('\n}');
    return signature + (end < 0 ? rest : rest.slice(0, end + 2));
  }
  const ends = [rest.search(/\n {2}(?:private |public |static )?(?:async )?[a-zA-Z_]+\s*\(/), rest.indexOf('\n}')]
    .filter((i) => i >= 0);
  return signature + (ends.length ? rest.slice(0, Math.min(...ends)) : rest);
}

/** Every `runInTransaction(...)` call's full argument text, by bracket matching. */
function transactionBodies(src: string): string[] {
  const out: string[] = [];
  const re = /runInTransaction(?:WithRetry)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** A seeded plan by code. A missing one is an EMPTY plan, so every assertion about it fails by name. */
const plan = (code: string): SeedPlan => {
  const p = ALL_PLANS.find((x) => x.code === code);
  if (!p) console.error(`      no seeded plan '${code}'`);
  return p ?? ({} as SeedPlan);
};
const MB = 1024 * 1024;
const GB = 1024 * MB;

const errOf = (fn: () => unknown): { code?: string; statusCode?: number } | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err as { code?: string; statusCode?: number };
  }
};
async function errOfAsync(fn: () => Promise<unknown>): Promise<{ code?: string; statusCode?: number; details?: unknown } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as { code?: string; statusCode?: number; details?: unknown };
  }
}

async function main(): Promise<void> {
  // ─── § 1 Provider plans (L-19) ──────────────────────────────────────────
  console.log('\n§ 1 the provider plans carry the L-19 numbers');

  const free = plan('provider_free');
  const plus = plan('provider_plus');
  const pro = plan('provider_pro');
  assert('Provider Free: 0 XAF, never expires, 100 credits, 1 listing, 500 MB, active', () =>
    free.role === 'vendor' && free.vendor_kind === 'provider' && free.price === 0 && free.term_days === null
    && free.credit_allowance === 100 && free.max_active_listings === 1 && free.max_storage_bytes === 500 * MB
    && free.is_active === true);
  assert('Provider Plus: 3,000 XAF / 30 days, 600 credits, 3 listings, 2 GB, active', () =>
    plus.vendor_kind === 'provider' && plus.price === 3_000 && plus.term_days === 30 && plus.credit_allowance === 600
    && plus.max_active_listings === 3 && plus.max_storage_bytes === 2 * GB && plus.is_active === true);
  assert('Provider Pro: 10,000 XAF / 30 days, 2,200 credits, 10 listings, 5 GB, active', () =>
    pro.vendor_kind === 'provider' && pro.price === 10_000 && pro.term_days === 30 && pro.credit_allowance === 2_200
    && pro.max_active_listings === 10 && pro.max_storage_bytes === 5 * GB && pro.is_active === true);
  assert('no provider plan sells products or takes a commission (nothing is sold through Wi-Mall)', () =>
    [free, plus, pro].every((p) => p.commission_percent === null && p.max_active_products === null && p.currency === 'XAF'));
  assert('a paid provider plan prices a credit BELOW the best top-up pack (else nobody subscribes)', () => {
    const bestPack = Math.min(...CREDIT_TOPUP_PACKS.map((p) => p.price / p.credits));
    return [plus, pro].every((p) => p.price / p.credit_allowance < bestPack);
  });
  assert('every seller plan is written `vendor_kind: seller` with no listing slots', () => {
    const sellers = ALL_PLANS.filter((p) => p.role === 'vendor' && ['starter', 'growth', 'business'].includes(p.code));
    return sellers.length === 3 && sellers.every((p) => p.vendor_kind === 'seller' && p.max_active_listings === null);
  });
  assert('every agency and agent plan is written `vendor_kind: null`, `max_active_listings: null`', () =>
    ALL_PLANS.filter((p) => p.role !== 'vendor').every((p) => p.vendor_kind === null && p.max_active_listings === null));
  assert('every vendor plan names its kind — none left to the "missing means seller" fallback', () =>
    ALL_PLANS.filter((p) => p.role === 'vendor').every((p) => p.vendor_kind === 'seller' || p.vendor_kind === 'provider'));
  assert('codes are unique per role (the seed upserts by role + code)', () =>
    new Set(ALL_PLANS.map((p) => `${p.role}:${p.code}`)).size === ALL_PLANS.length);
  const seedSrc = code('scripts/seed/seed-pricing-plans.ts');
  assert('the seed stays an idempotent upsert by role + code, and runs only as an entry point', () =>
    /updateOne\(\s*\{ role: plan\.role, code: plan\.code, deletedAt: null \}[\s\S]*?\{ upsert: true \}/.test(seedSrc)
    && /if \(require\.main === module\)/.test(seedSrc));

  // ─── § 2 Free plan per role AND kind ────────────────────────────────────
  console.log('\n§ 2 the free plan is per role AND kind, and every fallback resolves the kind');

  assert('vendor/seller → starter, vendor/provider → provider_free', () =>
    freePlanCode('vendor', 'seller') === 'starter' && freePlanCode('vendor', 'provider') === PROVIDER_FREE_PLAN_CODE
    && PROVIDER_FREE_PLAN_CODE === 'provider_free');
  assert('a vendor of unknown kind (null) falls back to the SELLER tier, as a kindless vendor is a seller', () =>
    freePlanCode('vendor', null) === 'starter');
  assert('agency and agent free tiers are unchanged, and ignore any kind', () =>
    freePlanCode('agency', 'provider') === FREE_PLAN_CODE_BY_ROLE.agency && freePlanCode('agent', null) === 'agent_free');
  assert('both vendor free tiers are known (the "is this a paid plan?" reads exclude both)', () =>
    freePlanCodesForRole('vendor').includes('starter') && freePlanCodesForRole('vendor').includes('provider_free')
    && freePlanCodesForRole('agency').length === 1);
  assert('the seeded free tiers are the codes freePlanCode names, free and never-expiring', () =>
    [plan(freePlanCode('vendor', 'seller')), plan(freePlanCode('vendor', 'provider'))]
      .every((p) => p.price === 0 && p.term_days === null));

  const freeCallers = tsFiles(SRC)
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))
    .filter(({ src }) => /\bfreePlanCode\(/.test(src));
  const oneArg = freeCallers.flatMap(({ f, src }) =>
    [...src.matchAll(/\bfreePlanCode\(([^()]*)\)/g)]
      .filter((m) => !m[1].includes(',') && !/role: BillingOwnerType/.test(m[1]))
      .map(() => f));
  if (oneArg.length) console.error(`      one-argument freePlanCode( in: ${oneArg.join(', ')}`);
  assert('⛔ no call in src/ asks for a free plan without the vendor kind', () => oneArg.length === 0);

  const sps = code('src/modules/billing/services/subscriber-plan.service.ts');
  assert('getActivePlan AND downgradeToFree resolve the free tier through the kind', () =>
    methodSpan(sps, 'async getActivePlan(').includes('this.freePlanCodeFor(ownerType, ownerId)')
    && methodSpan(sps, 'async downgradeToFree(').includes('this.freePlanCodeFor(ownerType, ownerId)')
    && methodSpan(sps, 'async freePlanCodeFor(').includes('freePlanCode(ownerType, await this.kindOf(ownerType, ownerId))'));

  // Drive the lazy free tier with fakes: requirePlanByCode runs BEFORE any transaction, so the
  // code it asks for is observable without a database.
  const askedFor: string[] = [];
  const spsFor = (kind: 'seller' | 'provider', active: unknown = null, pending: unknown = null, planById: unknown = null) =>
    new SubscriberPlanService(
      { findByOwnerAndStatus: async (_t: string, _o: string, status: string) => (status === 'active' ? active : pending) } as never,
      {
        findByCode: async (_role: string, c: string) => { askedFor.push(c); return null; },
        findById: async () => planById,
      } as never,
      {} as never,
      async (ownerType) => (ownerType === 'vendor' ? kind : null),
    );
  const VENDOR = '64c000000000000000000099';
  await assertAsync('a PROVIDER with no plan is lazily put on provider_free, a SELLER on starter', async () => {
    askedFor.length = 0;
    const e1 = await errOfAsync(() => spsFor('provider').getActivePlan('vendor', VENDOR));
    const e2 = await errOfAsync(() => spsFor('seller').getActivePlan('vendor', VENDOR));
    return askedFor[0] === 'provider_free' && askedFor[1] === 'starter'
      && e1?.code === ERROR_CODES.BILLING_PLAN_NOT_FOUND && e2?.code === ERROR_CODES.BILLING_PLAN_NOT_FOUND;
  });
  await assertAsync('a lapsed provider plan downgrades to provider_free, never to the seller tier', async () => {
    askedFor.length = 0;
    await errOfAsync(() => spsFor('provider').downgradeToFree('vendor', VENDOR, {} as never));
    return askedFor[0] === 'provider_free';
  });

  // ─── § 3 A plan's kind ──────────────────────────────────────────────────
  console.log('\n§ 3 a plan\'s kind — read, filter, refuse across kinds, publish');

  assert('planVendorKindOf: a vendor plan with no kind is a SELLER plan; non-vendor plans have none', () =>
    planVendorKindOf({ role: 'vendor' }) === 'seller'
    && planVendorKindOf({ role: 'vendor', vendor_kind: null }) === 'seller'
    && planVendorKindOf({ role: 'vendor', vendor_kind: 'provider' }) === 'provider'
    && planVendorKindOf({ role: 'agency', vendor_kind: 'provider' }) === null
    && planVendorKindOf(null) === null);
  assert('planServesOwner: role first, then the vendor kind (unknown vendor = seller)', () =>
    planServesOwner({ role: 'vendor' }, 'vendor', 'seller')
    && planServesOwner({ role: 'vendor' }, 'vendor', null)
    && !planServesOwner({ role: 'vendor' }, 'vendor', 'provider')
    && planServesOwner({ role: 'vendor', vendor_kind: 'provider' }, 'vendor', 'provider')
    && !planServesOwner({ role: 'vendor', vendor_kind: 'provider' }, 'vendor', 'seller')
    && planServesOwner({ role: 'agent' }, 'agent', null)
    && !planServesOwner({ role: 'agency' }, 'vendor', 'seller'));
  assert('⛔ a plan of the other kind is refused with BILLING_PLAN_ROLE_MISMATCH at its existing 409', () => {
    const across = errOf(() => assertPlanServesOwner({ role: 'vendor', vendor_kind: 'provider' }, 'vendor', 'seller'));
    const back = errOf(() => assertPlanServesOwner({ role: 'vendor' }, 'vendor', 'provider'));
    const role = errOf(() => assertPlanServesOwner({ role: 'agency' }, 'vendor', 'seller'));
    return across?.code === ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH && across.statusCode === 409
      && back?.code === ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH && back.statusCode === 409
      && role?.code === ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH && role.statusCode === 409
      && errOf(() => assertPlanServesOwner({ role: 'vendor', vendor_kind: 'provider' }, 'vendor', 'provider')) === null;
  });
  assert('the seller filter is `$ne: provider` (kindless plans stay listed), the provider one is exact', () =>
    JSON.stringify(vendorPlanKindFilter('seller')) === JSON.stringify({ vendor_kind: { $ne: 'provider' } })
    && vendorPlanKindFilter('seller') === SELLER_PLAN_FILTER
    && JSON.stringify(vendorPlanKindFilter('provider')) === JSON.stringify({ vendor_kind: 'provider' }));
  assert('a vendor\'s own plan list reads ITS kind (`listForVendorKind(vendorKindOf(role_entity))`)', () =>
    methodSpan(code('src/modules/billing/controllers/vendor-billing.controller.ts'), 'static listPlans')
      .includes('pricingPlanService.listForVendorKind(vendorKindOf(req.auth!.role_entity), true)'));

  await assertAsync('⛔ assignPlan refuses a provider plan to a SELLER before touching the active plan', async () => {
    const providerPlan = { _id: 'p', role: 'vendor', vendor_kind: 'provider', is_active: true };
    const e = await errOfAsync(() => spsFor('seller', null, null, providerPlan).assignPlan('vendor', VENDOR, 'p'));
    return e?.code === ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH && e.statusCode === 409;
  });
  await assertAsync('…and lets the same plan through for a PROVIDER (it reaches the two-plan rule)', async () => {
    const providerPlan = { _id: 'p', role: 'vendor', vendor_kind: 'provider', is_active: true };
    const active = { _id: 'a', expires_at: new Date(Date.now() + 86_400_000) };
    const e = await errOfAsync(() => spsFor('provider', active, { _id: 'q' }, providerPlan).assignPlan('vendor', VENDOR, 'p'));
    return e?.code === ERROR_CODES.BILLING_PENDING_PLAN_EXISTS;
  });
  await assertAsync('⛔ a self-service purchase across kinds is refused BEFORE any money is asked for', async () => {
    let charged = false;
    const purchases = new PlanPurchaseService(
      { create: async () => { charged = true; return {}; } } as never,
      { findById: async () => ({ _id: 'p', role: 'vendor', vendor_kind: 'provider', is_active: true, price: 3_000 }) } as never,
      {} as never,
      {} as never,
      async () => 'seller',
    );
    const e = await errOfAsync(() => purchases.initiatePurchase('vendor', VENDOR, 'p', { provider: 'mtn' } as never, {} as never));
    return e?.code === ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH && e.statusCode === 409 && !charged;
  });

  const publicProvider = toPublicPlanDto({ _id: 'x', role: 'vendor', vendor_kind: 'provider', max_active_listings: 3 } as never);
  const publicLegacy = toPublicPlanDto({ _id: 'y', role: 'vendor' } as never);
  const publicAgency = toPublicPlanDto({ _id: 'z', role: 'agency', max_active_listings: undefined } as never);
  assert('the public DTO publishes `vendorKind` and `maxActiveListings`', () =>
    publicProvider.vendorKind === 'provider' && publicProvider.maxActiveListings === 3
    && publicLegacy.vendorKind === 'seller' && publicLegacy.maxActiveListings === null
    && publicAgency.vendorKind === null && publicAgency.maxActiveListings === null);
  assert('GET /public/plans accepts an optional `vendorKind` and refuses an unknown one', () =>
    PublicListPlansQuerySchema.parse({ vendorKind: 'provider' }).vendorKind === 'provider'
    && PublicListPlansQuerySchema.parse({}).vendorKind === undefined
    && !PublicListPlansQuerySchema.safeParse({ vendorKind: 'shop' }).success);
  const base = { code: 'x_y', name: 'X Y', price: 0, term_days: null, credit_allowance: 0 };
  assert('the admin create validator takes `vendor_kind` + `max_active_listings` on a vendor plan', () => {
    const parsed = CreatePlanSchema.parse({ ...base, role: 'vendor', vendor_kind: 'provider', max_active_listings: 4 });
    return parsed.vendor_kind === 'provider' && parsed.max_active_listings === 4;
  });
  assert('…and refuses a vendor kind on an agency or agent plan', () =>
    !CreatePlanSchema.safeParse({ ...base, role: 'agency', vendor_kind: 'seller' }).success
    && CreatePlanSchema.safeParse({ ...base, role: 'agent', vendor_kind: null }).success);
  assert('the admin update validator takes `max_active_listings` and STRIPS `vendor_kind` (immutable)', () => {
    const parsed = UpdatePlanSchema.parse({ max_active_listings: 2, vendor_kind: 'provider' }) as Record<string, unknown>;
    return parsed.max_active_listings === 2 && !('vendor_kind' in parsed)
      && methodSpan(code('src/modules/billing/services/pricing-plan.service.ts'), 'async update(')
        .includes('delete (updates as Record<string, unknown>).vendor_kind;');
  });

  // ─── § 4 Wallet debt ────────────────────────────────────────────────────
  console.log('\n§ 4 the wallet may go negative on ONE path, and a credit pays the debt first');

  assert('the floor rule: no floor always passes; a floor is inclusive', () =>
    wouldStayAboveFloor(0, 7, null) && wouldStayAboveFloor(-1_000, 4, null)
    && wouldStayAboveFloor(-26, 4, -30) && !wouldStayAboveFloor(-27, 4, -30)
    && wouldStayAboveFloor(3, 7, -4) && !wouldStayAboveFloor(3, 7, -3)
    && wouldStayAboveFloor(10, 7, 0) && !wouldStayAboveFloor(6, 7, 0));
  assert('⛔ the atomic filter IS the pure rule (balance ≥ floor + amount; nothing when no floor)', () => {
    const cases: Array<[number, number, number | null]> = [[-26, 4, -30], [-27, 4, -30], [3, 7, -4], [0, 7, 0], [100, 7, null]];
    return cases.every(([balance, amount, floor]) => {
      const f = debtFloorFilter(amount, floor) as { balance?: { $gte: number } };
      const filterPasses = f.balance === undefined || balance >= f.balance.$gte;
      return filterPasses === wouldStayAboveFloor(balance, amount, floor);
    }) && Object.keys(debtFloorFilter(4, null)).length === 0;
  });
  assert('⛔ the wallet schema no longer says `min: 0` on balance (the service is the guard)', () =>
    CreditWalletModel.schema.path('balance').options.min === undefined);
  const repoSrc = code('src/modules/billing/repositories/credit-wallet.repository.ts');
  assert('debitIfSufficient still refuses what the balance cannot cover — every debit while negative', () =>
    methodSpan(repoSrc, 'async debitIfSufficient(').includes('balance: { $gte: amount }'));
  assert('a credit is arithmetic — no clamp anywhere on the credit path (−30 + 100 = 70)', () =>
    methodSpan(repoSrc, 'async credit(').includes('$inc: { balance: amount')
    && !/Math\.max|\$max/.test(methodSpan(repoSrc, 'async credit('))
    && !/Math\.max/.test(code('src/modules/billing/services/credit-wallet.service.ts')));

  // The service against fake repositories: what is written, and what is not.
  type Row = Record<string, unknown>;
  const fakeWallet = (balance: number) => {
    const state = { balance, rows: [] as Row[] };
    const wallet = () => ({ _id: 'w', owner_type: 'vendor', owner_id: { toString: () => VENDOR }, balance: state.balance });
    const svc = new CreditWalletService(
      {
        getOrCreate: async () => wallet(),
        findByOwner: async () => wallet(),
        credit: async (_id: unknown, amount: number) => { state.balance += amount; return wallet(); },
        debitIfSufficient: async (_id: unknown, amount: number) => {
          if (state.balance < amount) return null;
          state.balance -= amount; return wallet();
        },
        debitAllowingDebt: async (_id: unknown, amount: number, floor: number | null) => {
          if (!wouldStayAboveFloor(state.balance, amount, floor)) return null;
          state.balance -= amount; return wallet();
        },
        zeroNegativeBalance: async () => {
          if (state.balance >= 0) return null;
          const before = wallet(); state.balance = 0; return before;
        },
      } as never,
      { create: async (row: Row) => { state.rows.push(row); return row; } } as never,
    );
    return { state, svc };
  };
  const S = {} as never;

  await assertAsync('debitInSession throws BILLING_INSUFFICIENT_CREDITS 402 on a negative balance, writing nothing', async () => {
    const { state, svc } = fakeWallet(-3);
    const e = await errOfAsync(() => svc.debitInSession('vendor', VENDOR, 4, 'listing_reveal', 'r1', S));
    return e?.code === ERROR_CODES.BILLING_INSUFFICIENT_CREDITS && e.statusCode === 402 && state.rows.length === 0 && state.balance === -3;
  });
  await assertAsync('debitAllowingDebtInSession goes negative and writes a `debit` row with the new balance', async () => {
    const { state, svc } = fakeWallet(3);
    const w = await svc.debitAllowingDebtInSession('vendor', VENDOR, 7, null, 'listing_reveal', 'r2', S);
    const row = state.rows[0];
    return w?.balance === -4 && row?.type === 'debit' && row.amount === -7 && row.balance_after === -4
      && row.reason_code === 'listing_reveal' && row.ref === 'r2';
  });
  await assertAsync('…and returns null AT the floor, writing nothing', async () => {
    const { state, svc } = fakeWallet(-27);
    const w = await svc.debitAllowingDebtInSession('vendor', VENDOR, 4, -30, 'listing_reveal', 'r3', S);
    return w === null && state.rows.length === 0 && state.balance === -27;
  });
  await assertAsync('a credit on a negative balance pays the debt first: −30 + 100 = 70', async () => {
    const { state, svc } = fakeWallet(-30);
    const w = await svc.creditInSession('vendor', VENDOR, 100, 'topup', 'topup_purchase', 't1', S);
    return w.balance === 70 && state.rows[0]?.balance_after === 70 && state.rows[0]?.amount === 100;
  });

  // ─── § 5 ⛔ debitAllowingDebt has one caller ─────────────────────────────
  console.log('\n§ 5 ⛔ debitAllowingDebt is reachable from the listing reveal alone');

  const REVEAL_SERVICE = 'src/modules/listings/services/listing-reveal.service.ts';
  const BILLING_DIR = 'src/modules/billing/';
  const debtCallers = tsFiles(SRC)
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))
    .filter(({ src }) => /\bdebitAllowingDebt(InSession)?\b/.test(src));
  const outside = debtCallers.filter(({ f }) => !f.startsWith(BILLING_DIR)).map(({ f }) => f);
  if (outside.length) console.log(`      debitAllowingDebt callers outside billing: ${outside.join(', ')}`);
  // Wave 1: ZERO callers (the reveal is wave 2). The lead tightens this to `=== 1` once
  // ListingRevealService lands, so an accidental second caller AND a reveal that stopped using
  // it both fail.
  assert('⛔ outside billing, only ListingRevealService may name debitAllowingDebt (⊆ {reveal}, ≤ 1)', () =>
    outside.every((f) => f === REVEAL_SERVICE) && outside.length <= 1);
  const insideBilling = debtCallers.filter(({ f }) => f.startsWith(BILLING_DIR)).map(({ f }) => f).sort();
  assert('⛔ inside billing, only the wallet repository (the write) and the wallet service (the door) name it', () =>
    JSON.stringify(insideBilling) === JSON.stringify([
      'src/modules/billing/repositories/credit-wallet.repository.ts',
      'src/modules/billing/services/credit-wallet.service.ts',
    ]));

  // ─── § 6 ⛔ billing.wallet.credited on every credit path ─────────────────
  console.log('\n§ 6 ⛔ every credit publishes billing.wallet.credited, after its commit');

  const walletSvc = code('src/modules/billing/services/credit-wallet.service.ts');
  const creditSpan = methodSpan(walletSvc, 'async credit(');
  assert('⛔ CreditWalletService.credit() publishes, AFTER its own transaction resolves', () =>
    creditSpan.includes('publishWalletCredited(updated, reasonCode)')
    && creditSpan.indexOf('publishWalletCredited(') > creditSpan.indexOf('runInTransaction(')
    && !transactionBodies(creditSpan).some((t) => t.includes('publishWalletCredited(')));

  /**
   * Every file calling `creditInSession(` on the CREDIT WALLET (not the COD cash account, which
   * shares the method name) must be registered here with the spans that publish. A new caller —
   * the listings refund, wave 2 — fails this until it is registered AND publishes.
   */
  const IN_SESSION_CALLERS: Record<string, { publishers: string[]; exempt?: string[] }> = {
    'src/modules/billing/services/credit-topup.service.ts': {
      publishers: ['async completeTopup('],
      exempt: ['async reverseTopup('], // a NEGATIVE credit: the balance goes down, nothing resumes
    },
    'src/modules/billing/services/subscriber-plan.service.ts': {
      publishers: ['async getActivePlan(', 'async assignPlan(', 'async activatePending('],
    },
    // The listings index-fee refund (O-18). The credit is inside the exported `refundIndexFee`,
    // which RETURNS the wallet; each transaction calling it publishes after its commit — the
    // three provider verbs here, and the administrator's reject (checked below).
    'src/modules/listings/domain/services/listing-provider.service.ts': {
      publishers: ['async withdraw(', 'async discardRevision(', 'async archive('],
      exempt: ['export async function refundIndexFee('],
    },
  };
  const walletImporters = tsFiles(SRC)
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))
    .filter(({ src }) => /credit-wallet\.service'/.test(src) && /\.creditInSession\(/.test(src))
    .map(({ f }) => f)
    .sort();
  if (walletImporters.join() !== Object.keys(IN_SESSION_CALLERS).sort().join()) {
    console.error(`      creditInSession callers: ${walletImporters.join(', ')}`);
  }
  assert('⛔ the creditInSession callers are exactly the registered ones (a new one must be registered)', () =>
    JSON.stringify(walletImporters) === JSON.stringify(Object.keys(IN_SESSION_CALLERS).sort()));
  for (const [file, { publishers, exempt }] of Object.entries(IN_SESSION_CALLERS)) {
    const src = code(file);
    for (const sig of publishers) {
      const span = methodSpan(src, sig);
      assert(`⛔ ${path.basename(file)} ${sig.replace('async ', '').replace('(', '')}() publishes after its commit`, () =>
        /publishWalletCredited\(|this\.publishCredit\(/.test(span)
        && !transactionBodies(span).some((t) => /publishWalletCredited\(|this\.publishCredit\(/.test(t)));
    }
    // Every `.creditInSession(` in the file must fall inside a registered method, or a new credit
    // path added beside the registered ones would pass unseen.
    const registered = [...publishers, ...(exempt ?? [])]
      .map((sig) => ({ start: src.indexOf(sig), len: methodSpan(src, sig).length }))
      .filter((r) => r.start >= 0);
    const calls = [...src.matchAll(/\.creditInSession\(/g)].map((m) => m.index ?? -1);
    assert(`⛔ ${path.basename(file)}: every creditInSession call sits in a registered method`, () =>
      calls.length > 0 && calls.every((at) => registered.some((r) => at > r.start && at < r.start + r.len))
      // subscriber-plan's one call is in grantAllowance, which every registered publisher reaches.
      || (file.endsWith('subscriber-plan.service.ts')
        && calls.length === 1 && methodSpan(src, 'private async grantAllowance(').includes('.creditInSession(')));
  }
  // Indirect credit paths: every method anywhere in src/ that calls the listings fee refund must
  // publish after its own transaction (the reject lives in another file from the credit).
  const refundCallers = tsFiles(path.join(SRC, 'modules', 'listings'))
    .map((f) => ({ f: rel(f), src: stripComments(readFileSync(f, 'utf8')) }))
    .flatMap(({ f, src }) => [...src.matchAll(/\n {2}(?:private )?async ([a-zA-Z]+)\(/g)]
      .map((m) => ({ f, name: m[1], span: methodSpan(src, m[0].slice(1)) }))
      .filter(({ span, name }) => name !== 'refundFeeInSession' && /\b(refundIndexFee|this\.refundFeeInSession)\(/.test(span)));
  if (refundCallers.length) console.log(`      index-fee refund callers: ${refundCallers.map((c) => `${path.basename(c.f)}#${c.name}`).join(', ')}`);
  assert('⛔ every index-fee refund publishes billing.wallet.credited after its commit', () =>
    refundCallers.every(({ span }) =>
      span.includes('publishWalletCredited(') && !transactionBodies(span).some((t) => t.includes('publishWalletCredited('))));
  assert('the plan grant hands its wallet to `publishCredit`, which publishes `plan_allowance`', () =>
    methodSpan(sps, 'private async grantAllowance(').includes('return credited;')
    && methodSpan(sps, 'private publishCredit(').includes("publishWalletCredited(activation.credited, 'plan_allowance')"));
  assert('a top-up publishes `topup_purchase`, and a replayed completion (already paid) publishes nothing', () => {
    const span = methodSpan(code('src/modules/billing/services/credit-topup.service.ts'), 'async completeTopup(');
    return span.includes("if (credited) publishWalletCredited(credited, 'topup_purchase')")
      && span.includes("if (topup.status === 'paid') return { topup, credited: null };");
  });
  assert('the payload is exactly § C-5: { type, ownerType, ownerId, balanceAfter, reasonCode }', () => {
    const p = walletCreditedPayload({ owner_type: 'vendor', owner_id: { toString: () => VENDOR }, balance: 70 }, 'topup_purchase');
    return JSON.stringify(Object.keys(p)) === JSON.stringify(['type', 'ownerType', 'ownerId', 'balanceAfter', 'reasonCode'])
      && p.type === 'billing.wallet.credited' && p.ownerId === VENDOR && p.balanceAfter === 70 && p.reasonCode === 'topup_purchase';
  });
  await assertAsync('publishWalletCredited really reaches a subscriber on the bus', async () => {
    let seen: Record<string, unknown> | null = null;
    eventBus.subscribe(WALLET_CREDITED_EVENT, (e) => { seen = e.payload; }, 'test:service-listings-billing');
    publishWalletCredited({ owner_type: 'vendor', owner_id: { toString: () => VENDOR }, balance: 12 }, 'plan_allowance');
    await new Promise((r) => setImmediate(r));
    const got = seen as Record<string, unknown> | null;
    return got !== null && got.balanceAfter === 12 && got.reasonCode === 'plan_allowance' && got.ownerType === 'vendor';
  });

  // ─── § 7 Role closure (L-12) ────────────────────────────────────────────
  console.log('\n§ 7 role closure — the debt is warned about, written off, and the listings closed');

  assert('a negative balance warns `credit_debt_written_off` with the debt as a POSITIVE amount', () => {
    const w = creditWarningsFor(-30);
    return w.length === 1 && w[0].code === 'credit_debt_written_off' && w[0].amount === 30;
  });
  assert('a positive balance still warns `credit_balance_forfeited`; zero warns nothing', () =>
    creditWarningsFor(45)[0]?.code === 'credit_balance_forfeited' && creditWarningsFor(45)[0]?.amount === 45
    && creditWarningsFor(0).length === 0);
  assert('the warning code is registered (so the request model\'s enum accepts it)', () =>
    (ROLE_CLOSURE_WARNING_CODES as readonly string[]).includes('credit_debt_written_off')
    && (ROLE_CLOSURE_WARNING_CODES as readonly string[]).includes('credit_balance_forfeited'));
  assert('the write-off decision: the debt as a positive number, 0 for any balance ≥ 0', () =>
    debtToWriteOff(-30) === 30 && debtToWriteOff(0) === 0 && debtToWriteOff(12) === 0);
  await assertAsync('the write-off brings −30 to exactly 0 with ONE `adjustment` row, ref = the request', async () => {
    const { state, svc } = fakeWallet(-30);
    const amount = await svc.writeOffDebtInSession('vendor', VENDOR, 'req-1', S);
    const row = state.rows[0];
    return amount === 30 && state.balance === 0 && state.rows.length === 1 && row.type === 'adjustment'
      && row.amount === 30 && row.balance_after === 0 && row.reason_code === 'credit_debt_written_off' && row.ref === 'req-1';
  });
  await assertAsync('…and writes NOTHING for a balance at or above zero', async () => {
    const { state, svc } = fakeWallet(15);
    return (await svc.writeOffDebtInSession('vendor', VENDOR, 'req-2', S)) === 0 && state.rows.length === 0 && state.balance === 15;
  });
  const closure = code('src/modules/role-closure/services/role-closure.service.ts');
  const confirm = closure.slice(closure.indexOf('async confirm('), closure.indexOf('private async requirePendingForCaller'));
  const tx = transactionBodies(confirm)[0] ?? '';
  assert('⛔ the write-off runs INSIDE the confirm transaction, after the request CAS, for every non-customer role', () =>
    tx.includes('this.wallet.writeOffDebtInSession(role, roleEntityId, request._id.toString(), session)')
    && tx.indexOf('this.requests.confirm(') < tx.indexOf('writeOffDebtInSession(')
    && /role === 'customer'\s*\?\s*0/.test(tx));
  const manifest = code('src/modules/role-closure/role-closure.manifest.ts');
  const closeVendor = methodSpan(manifest, 'async closeVendor(');
  const closeListings = methodSpan(manifest, 'private async closeListings(');
  assert('⛔ a vendor closure archives every listing and ERASES listing_contacts, in the session', () =>
    closeVendor.includes('await this.closeListings(vendorId, closedAt, session)')
    && /status: 'archived', archived_at: closedAt/.test(closeListings)
    // The erase goes through the ONE door to listing_contacts (lead, 2026-10-20), in the session.
    && /await listingContactRepository\.eraseForVendor\(String\(vendorId\), session\)/.test(closeListings)
    && (closeListings.match(/\{ session \}/g) ?? []).length === 2);
  assert('…clears the suspension and the in-review revision, and never deletes a listing', () =>
    closeListings.includes('suspension: null, pending: null, review: null') && !/deleteMany|deleteOne/.test(closeListings));
  assert('a customer closure REVOKES every granted provider consent', () => {
    const cust = methodSpan(manifest, 'async closeCustomer(');
    return /ProviderContactConsentModel\.updateMany\(\s*\{ customer_id: customerId, granted_at: \{ \$ne: null \}, revoked_at: null \},\s*\{ \$set: \{ revoked_at: closedAt \} \}/.test(cust);
  });
  assert('the manifest still imports no money collection (ADR-A02 D-1)', () =>
    !/earnings|payout|cod\/|payments\/|refund|billing/i.test(
      read('src/modules/role-closure/role-closure.manifest.ts').split('\n').filter((l) => l.startsWith('import')).join('\n')));
  const blockersSrc = code('src/modules/role-closure/services/role-closure-blockers.service.ts');
  assert('the prepaid-plan warning skips BOTH vendor free tiers', () =>
    blockersSrc.includes('plan_code: { $nin: freePlanCodesForRole(role) }'));

  // ─── § 8 Listing quota (O-16) ───────────────────────────────────────────
  console.log('\n§ 8 the listing quota on a downgrade — oldest stay, newest wait, others untouched');

  assert('§ C-8a: live, pending_review and non-quota suspensions hold a slot; quota-suspended does not', () =>
    occupiesListingSlot({ status: 'live', suspensionReason: null })
    && occupiesListingSlot({ status: 'pending_review', suspensionReason: null })
    && occupiesListingSlot({ status: 'suspended', suspensionReason: 'insufficient_credits' })
    && occupiesListingSlot({ status: 'suspended', suspensionReason: 'platform_oversight' })
    && !occupiesListingSlot({ status: 'suspended', suspensionReason: 'plan_quota_exceeded' })
    && !occupiesListingSlot({ status: 'draft', suspensionReason: null })
    && !occupiesListingSlot({ status: 'archived', suspensionReason: null }));
  const slots = (...rows: Array<[string, ListingSlot['status'], ListingSlot['suspensionReason']]>): ListingSlot[] =>
    rows.map(([id, status, suspensionReason]) => ({ id, status, suspensionReason }));
  const cut = (s: ListingSlot[], limit: number | null) => planCountCutoff(s.map(toListingQuotaCandidate), limit);
  assert('⛔ a downgrade to 1 keeps the OLDEST and suspends the newer two', () => {
    const p = cut(slots(['a', 'live', null], ['b', 'live', null], ['c', 'pending_review', null]), 1);
    return JSON.stringify(p.allowed) === '["a"]' && JSON.stringify(p.toBlock) === '["b","c"]' && p.toRelease.length === 0;
  });
  assert('⛔ a listing suspended for insufficient credits is PINNED: kept, never asked to move', () => {
    const p = cut(slots(['a', 'live', null], ['b', 'suspended', 'insufficient_credits'], ['c', 'live', null]), 1);
    return !p.toBlock.includes('b') && !p.toRelease.includes('b') && p.allowed.includes('b')
      && JSON.stringify(p.toBlock) === '["a","c"]';
  });
  assert('⛔ an upgrade releases quota-suspended listings OLDEST-FIRST until full', () => {
    const p = cut(slots(['a', 'live', null], ['b', 'suspended', 'plan_quota_exceeded'], ['c', 'suspended', 'plan_quota_exceeded'], ['d', 'suspended', 'plan_quota_exceeded']), 3);
    return JSON.stringify(p.toRelease) === '["b","c"]' && p.toBlock.length === 0;
  });
  assert('unlimited (null) releases every quota suspension; 0 denies everything', () =>
    cut(slots(['a', 'suspended', 'plan_quota_exceeded']), null).toRelease.length === 1
    && cut(slots(['a', 'live', null]), 0).toBlock.length === 1);
  assert('a restore returns the exact previous status…', () =>
    listingRestoreTarget('live', 50, LISTING_REVEAL_FIRST_COST).status === 'live'
    && listingRestoreTarget('pending_review', 0, LISTING_REVEAL_FIRST_COST).status === 'pending_review'
    && listingRestoreTarget('live', LISTING_REVEAL_FIRST_COST, LISTING_REVEAL_FIRST_COST).suspension === null);
  assert('…except `live` below the first-reveal cost, which returns suspended `insufficient_credits` (§ C-8a)', () => {
    const t = listingRestoreTarget('live', LISTING_REVEAL_FIRST_COST - 1, LISTING_REVEAL_FIRST_COST);
    return t.status === 'suspended' && t.suspension?.reason === 'insufficient_credits' && t.suspension.previous_status === 'live';
  });
  const lqRepo = code('src/modules/plan-quota/repositories/listing-quota.repository.ts');
  assert('⛔ the suspend is a PIPELINE capturing `previous_status: \'$status\'`, from live/pending_review only', () => {
    const s = methodSpan(lqRepo, 'async suspendForQuota(');
    return s.includes("previous_status: '$status'") && s.includes('reason: LISTING_QUOTA_REASON')
      && s.includes('status: { $in: [...LISTING_QUOTA_SUSPENDABLE] }') && LISTING_QUOTA_REASON === 'plan_quota_exceeded';
  });
  assert('⛔ a restore is a compare-and-set on the QUOTA reason — no other suspension is ever lifted', () =>
    methodSpan(lqRepo, 'async restoreFromQuota(').includes("status: 'suspended', 'suspension.reason': LISTING_QUOTA_REASON"));
  assert('the slot read is oldest-first with an `_id` tie-break', () =>
    methodSpan(lqRepo, 'async listSlotsOldestFirst(').includes('.sort({ created_at: 1, _id: 1 })'));
  const enforcement = code('src/modules/plan-quota/domain/services/plan-quota-enforcement.service.ts');
  assert('⛔ the listing axis is enforced for PROVIDER vendors only; sellers are untouched', () =>
    /ownerType === 'vendor' && \(await this\.kindOf\(ownerType, ownerId\)\) === 'provider'\s*\?\s*await this\.applyListingQuota\(ownerId, maxListings\)/.test(enforcement));
  assert('the state row stamps the listing LIMIT VALUE, and the sweep compares it', () => {
    const worker = code('src/modules/plan-quota/workers/plan-quota-reconcile.worker.ts');
    return enforcement.includes('enforced_max_listings: maxListings')
      && worker.includes('(state.enforced_max_listings ?? null) !== expectedMaxListings');
  });
  assert('the sweep also picks up providers merely HOLDING a listing back', () =>
    code('src/modules/plan-quota/workers/plan-quota-reconcile.worker.ts').includes('this.listingRepo.vendorsHoldingQuotaSuspensions()'));
  assert('`quota.capacity_freed` reports a listing restore too', () =>
    code('src/modules/plan-quota/events/plan-quota.consumer.ts').includes('outcome.listingsRestored === 0'));

  // ─── § 9 Public costs ───────────────────────────────────────────────────
  console.log('\n§ 9 GET /public/credit-packs publishes both reveal costs');

  await assertAsync('actionCosts carries listingRevealFirst / listingRevealNext from credit.config', async () => {
    let body: { data?: { actionCosts?: Record<string, number> } } | null = null;
    await new Promise<void>((resolve, reject) => {
      const res = {
        set: () => res,
        json: (b: typeof body) => { body = b; resolve(); return res; },
      };
      PublicBillingController.listCreditPacks({} as never, res as never, reject as never);
    });
    const costs = (body as { data?: { actionCosts?: Record<string, number> } } | null)?.data?.actionCosts ?? {};
    return costs.listingRevealFirst === LISTING_REVEAL_FIRST_COST && costs.listingRevealNext === LISTING_REVEAL_NEXT_COST
      && typeof costs.vectorisation === 'number' && typeof costs.aiCopyField === 'number';
  });

  // ─── § 10 Transactions feed ─────────────────────────────────────────────
  console.log('\n§ 10 the transactions feed labels the three listing reason codes');

  assert('a reveal is usage; a reveal refund and a debt write-off are adjustments', () =>
    CREDIT_TYPE_BY_REASON.listing_reveal === 'credit_usage'
    && CREDIT_TYPE_BY_REASON.listing_reveal_refund === 'credit_adjustment'
    && CREDIT_TYPE_BY_REASON.credit_debt_written_off === 'credit_adjustment');
  assert('each has a human description, not the anonymous fallback', () =>
    ['listing_reveal', 'listing_reveal_refund', 'credit_debt_written_off']
      .every((r) => typeof CREDIT_DESC_BY_REASON[r as keyof typeof CREDIT_DESC_BY_REASON] === 'string'));
  assert('sellers\' existing labels are byte-identical', () =>
    CREDIT_TYPE_BY_REASON.plan_allowance === 'credit_allowance' && CREDIT_TYPE_BY_REASON.vectorisation === 'credit_usage'
    && CREDIT_TYPE_BY_REASON.ai_listing_copy === 'credit_usage' && CREDIT_TYPE_BY_REASON.admin_adjustment === 'credit_adjustment'
    && CREDIT_DESC_BY_REASON.vectorisation === 'Product vectorisation' && CREDIT_DESC_BY_REASON.ai_listing_copy === 'AI listing copy');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
