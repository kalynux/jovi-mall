/**
 * verify:service-listings-billing — the billing half of service listings against REAL Mongo.
 *
 * ⛔ NEEDS A REPLICA SET (every wallet write is a transaction), and it DROPS ITS DATABASE at the
 * end, pass or fail. It therefore refuses to run against any database not named `sl_billing`,
 * and it deliberately does NOT load `.env` — a stray MONGO_URI there is the real database.
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/sl_billing?replicaSet=rs0" npm run verify:service-listings-billing
 *
 * What `test:service-listings-billing` structurally cannot see, and this proves:
 *   § 1  `debitAllowingDebt` really goes negative, stops EXACTLY at the floor (inclusive), and has
 *        no limit with `floor: null` — the guard is a query filter, and a fake cannot fail one;
 *        `debitIfSufficient` refuses on a negative balance; a credit pays the debt first
 *        (−30 + 100 = 70) and publishes `billing.wallet.credited`; balance == Σ ledger.
 *   § 2  the lazy free tier is per KIND (provider_free / starter) and its grant publishes;
 *        an assignment across kinds is refused.
 *   § 3  a provider's role-closure confirm writes the write-off row and ends at balance 0,
 *        archives every listing and erases every contact set — in one transaction.
 *   § 4  the listing quota: a downgrade suspends the NEWEST past the allowance capturing each
 *        one's real status, an upgrade restores oldest-first, a listing suspended for
 *        `insufficient_credits` is never touched, a seller is never swept, the real
 *        `plan.activated` chain triggers it, and an in-place plan edit is caught by the sweep.
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';
import { eventBus, DomainEvent } from '../../src/core/events/event-bus';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { CreditWalletModel } from '../../src/modules/billing/models/credit-wallet.model';
import { CreditTransactionModel } from '../../src/modules/billing/models/credit-transaction.model';
import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { SubscriberPlanModel } from '../../src/modules/billing/models/subscriber-plan.model';
import { creditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { subscriberPlanService } from '../../src/modules/billing/services/subscriber-plan.service';
import { WALLET_CREDITED_EVENT } from '../../src/modules/billing/domain/wallet-credited.event';
import { RoleClosureService } from '../../src/modules/role-closure/services/role-closure.service';
import { ListingModel } from '../../src/modules/listings/models/listing.model';
import { ListingContactModel } from '../../src/modules/listings/models/listing-contact.model';
import { PlanQuotaStateModel } from '../../src/modules/plan-quota/models/plan-quota-state.model';
import { planQuotaEnforcementService } from '../../src/modules/plan-quota/domain/services/plan-quota-enforcement.service';
import { registerPlanQuotaConsumer } from '../../src/modules/plan-quota/events/plan-quota.consumer';
import { planQuotaReconcileWorker } from '../../src/modules/plan-quota/workers/plan-quota-reconcile.worker';
import { LISTING_REVEAL_FIRST_COST } from '../../src/modules/billing/config/credit.config';

// Under CI the URI is in `.env` (the job writes it there, not into the environment), so CI alone
// loads it: locally a stray `.env` MONGO_URI is the real database, and this suite stays off it.
if (process.env.CI) dotenv.config();
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27117/sl_billing?replicaSet=rs0';
const REQUIRED_DB = 'sl_billing';

let passed = 0;
let failed = 0;
async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
  try {
    if (await fn()) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}
async function refusedWith(code: string, status: number, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (err) {
    const e = err as { code?: string; statusCode?: number };
    if (e.code !== code || e.statusCode !== status) console.error(`      expected ${code}/${status}, got ${e.code}/${e.statusCode}: ${(err as Error).message}`);
    return e.code === code && e.statusCode === status;
  }
}

const oid = () => new Types.ObjectId();
const col = (name: string) => mongoose.connection.db!.collection(name);
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wallet events seen on the bus, newest last. */
const credited: Array<Record<string, unknown>> = [];

async function balanceOf(ownerId: Types.ObjectId): Promise<number> {
  const w = await CreditWalletModel.findOne({ owner_type: 'vendor', owner_id: ownerId }).lean();
  return w?.balance ?? NaN;
}
async function ledgerSum(ownerId: Types.ObjectId): Promise<number> {
  const rows = await CreditTransactionModel.find({ owner_type: 'vendor', owner_id: ownerId }).lean();
  return rows.reduce((s, r) => s + r.amount, 0);
}
/** A grace-reveal debit, the way ListingRevealService will make one: inside its own transaction. */
async function graceDebit(vendorId: Types.ObjectId, amount: number, floor: number | null) {
  return transactionManager.runInTransaction((session) =>
    creditWalletService.debitAllowingDebtInSession('vendor', vendorId.toString(), amount, floor, 'listing_reveal', `rv-${oid()}`, session));
}
async function waitFor(pred: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}

async function plan(code: string, fields: Record<string, unknown>): Promise<Types.ObjectId> {
  const doc = await PricingPlanModel.create({
    role: 'vendor', code, name: code, price: 0, currency: 'XAF', term_days: null, credit_allowance: 0,
    max_active_products: null, max_storage_bytes: null, commission_percent: null,
    max_unterminated_shipments: null, live_tracking_enabled: true, is_active: true, sort_order: 50,
    ...fields,
  });
  return doc._id as Types.ObjectId;
}
async function putOnPlan(vendorId: Types.ObjectId, planId: Types.ObjectId): Promise<void> {
  await SubscriberPlanModel.deleteMany({ owner_id: vendorId });
  const p = await PricingPlanModel.findById(planId).lean();
  await SubscriberPlanModel.create({
    owner_type: 'vendor', owner_id: vendorId, plan_id: planId, plan_code: p!.code,
    status: 'active', started_at: new Date(), expires_at: null, allowance_granted: true,
  });
}
async function setBalance(vendorId: Types.ObjectId, balance: number): Promise<void> {
  await CreditWalletModel.updateOne(
    { owner_type: 'vendor', owner_id: vendorId },
    { $set: { balance }, $setOnInsert: { currency_unit: 'credit', version: 0 } },
    { upsert: true },
  );
}
async function listing(vendorId: Types.ObjectId, minute: number, status: string, suspension: Record<string, unknown> | null = null) {
  const _id = oid();
  await col(COLLECTIONS.LISTING).insertOne({
    _id, vendor_id: vendorId, slug: `sl-${_id}`, status, suspension, published: null, pending: null, review: null,
    last_decision: null, available_fields: [], published_at: null, archived_at: null,
    vectorisation_status: 'not_started', vectorised_data_id: null, vectorisation_job: null,
    created_at: at(minute), updated_at: at(minute),
  });
  return _id;
}
const statusOf = async (id: Types.ObjectId) =>
  (await ListingModel.findById(id).lean()) as unknown as { status: string; suspension: { reason: string; previous_status: string; at: Date } | null };

async function main(): Promise<void> {
  const dbName = new URL(MONGO_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
  // Under CI the URI names the SHARED `jovi_mall_ci`: move to the sibling this suite owns and drops.
  const underCi = !!process.env.CI;
  if (!underCi && dbName !== REQUIRED_DB) {
    console.error(`Refusing to run: this suite DROPS its database, and '${dbName}' is not '${REQUIRED_DB}'.`);
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, underCi ? { dbName: REQUIRED_DB } : {});
  console.log(`Connected to ${MONGO_URI.replace(/\/\/[^@]*@/, '//***@')}`);

  // Raw vendor rows carry a user_id: `vendors.user_id` is unique, and several nulls collide.
  // A fresh database has no collections, and creating one (or an autoIndex build racing it)
  // inside a transaction is exactly the catalog conflict that would make this suite flaky.
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).init().catch(() => undefined);
  }
  eventBus.subscribe(WALLET_CREDITED_EVENT, (e: DomainEvent) => { credited.push(e.payload); }, 'verify:service-listings-billing');

  try {
    // ─── § 1 The wallet's debt path ────────────────────────────────────────
    console.log('\n§ 1 debitAllowingDebt against a real wallet');
    const v1 = oid();
    await creditWalletService.credit('vendor', v1.toString(), 3, 'adjustment', 'admin_adjustment', 'seed');

    await assert('a grace debit with no floor takes 3 to −4', async () =>
      (await graceDebit(v1, 7, null))?.balance === -4 && (await balanceOf(v1)) === -4);
    await assert('…and has NO limit with floor null (−4 − 1000 = −1004)', async () =>
      (await graceDebit(v1, 1_000, null))?.balance === -1_004);
    const v2 = oid();
    await creditWalletService.credit('vendor', v2.toString(), 2, 'adjustment', 'admin_adjustment', 'seed');
    await assert('with floor −10: 2 → −2 → −6 → −10 (the floor itself is reachable)', async () =>
      (await graceDebit(v2, 4, -10))?.balance === -2
      && (await graceDebit(v2, 4, -10))?.balance === -6
      && (await graceDebit(v2, 4, -10))?.balance === -10);
    await assert('⛔ …and stops EXACTLY at the floor: one credit more returns null and writes nothing', async () => {
      const before = await CreditTransactionModel.countDocuments({ owner_id: v2 });
      const r = await graceDebit(v2, 1, -10);
      return r === null && (await balanceOf(v2)) === -10 && (await CreditTransactionModel.countDocuments({ owner_id: v2 })) === before;
    });
    await assert('⛔ debitIfSufficient REFUSES on a negative balance (402), however small the debit', () =>
      refusedWith('BILLING_INSUFFICIENT_CREDITS', 402, () => creditWalletService.debit('vendor', v2.toString(), 1, 'vectorisation', 'x')));
    await assert('the grace debit writes `debit` rows, reason listing_reveal, carrying the negative balance', async () => {
      const rows = await CreditTransactionModel.find({ owner_id: v2, reason_code: 'listing_reveal' }).sort({ created_at: 1 }).lean();
      return rows.length === 3 && rows.every((r) => r.type === 'debit' && r.amount === -4) && rows[2].balance_after === -10;
    });

    const v3 = oid();
    await creditWalletService.credit('vendor', v3.toString(), 0, 'adjustment', 'admin_adjustment', 'seed');
    await graceDebit(v3, 30, null);
    credited.length = 0;
    await assert('⛔ a credit pays the debt first: −30 + 100 = 70', async () =>
      (await creditWalletService.credit('vendor', v3.toString(), 100, 'topup', 'topup_purchase', 't1')).balance === 70
      && (await balanceOf(v3)) === 70);
    await assert('…and publishes billing.wallet.credited with balanceAfter 70, after the commit', async () =>
      waitFor(async () => credited.some((p) => p.ownerId === v3.toString() && p.balanceAfter === 70 && p.reasonCode === 'topup_purchase')));
    await assert('balance == Σ ledger on every wallet touched (no clamp, no lost row)', async () =>
      (await balanceOf(v1)) === (await ledgerSum(v1)) && (await balanceOf(v2)) === (await ledgerSum(v2))
      && (await balanceOf(v3)) === (await ledgerSum(v3)));
    await assert('a negative balance SAVES — the schema no longer refuses it', async () => {
      const w = await CreditWalletModel.findOne({ owner_id: v2 });
      w!.version += 1;
      await w!.save();
      return (await balanceOf(v2)) === -10;
    });

    // ─── § 2 Free tier per kind ────────────────────────────────────────────
    console.log('\n§ 2 the free tier follows the vendor kind');
    await plan('starter', { vendor_kind: 'seller', credit_allowance: 400, max_active_products: 80 });
    await plan('provider_free', { vendor_kind: 'provider', credit_allowance: 100, max_active_listings: 1 });
    const sellerPlusId = await plan('sl_seller_paid', { vendor_kind: 'seller', price: 7_500, term_days: 30 });

    const provider = oid();
    const seller = oid();
    await col(COLLECTIONS.VENDOR).insertMany([{ _id: provider, user_id: oid(), kind: 'provider' }, { _id: seller, user_id: oid() }]);
    credited.length = 0;
    await assert('a PROVIDER with no plan is lazily put on provider_free, granted its 100 credits', async () => {
      const sp = await subscriberPlanService.getActivePlan('vendor', provider.toString());
      return sp.plan_code === 'provider_free' && (await balanceOf(provider)) === 100;
    });
    await assert('…and the grant publishes billing.wallet.credited (plan_allowance)', async () =>
      waitFor(async () => credited.some((p) => p.ownerId === provider.toString() && p.reasonCode === 'plan_allowance' && p.balanceAfter === 100)));
    await assert('a vendor with NO kind (a pre-2026-10-19 seller) is put on starter', async () =>
      (await subscriberPlanService.getActivePlan('vendor', seller.toString())).plan_code === 'starter');
    await assert('⛔ a seller plan assigned to the provider is refused (BILLING_PLAN_ROLE_MISMATCH 409)', () =>
      refusedWith('BILLING_PLAN_ROLE_MISMATCH', 409, () => subscriberPlanService.assignPlan('vendor', provider.toString(), sellerPlusId.toString())));

    // ─── § 3 Closure write-off ─────────────────────────────────────────────
    console.log('\n§ 3 a provider closes in debt');
    const userId = oid();
    const closing = oid();
    await col(COLLECTIONS.USER).insertOne({
      _id: userId, login_email: `sl-${userId}@verify.test`, login_phone: '+237600000777',
      password_hash: '$2b$12$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyzABCDE', roles: ['vendor'], status: 'active',
    });
    await col(COLLECTIONS.VENDOR).insertOne({
      _id: closing, user_id: userId, kind: 'provider', display_name: 'Plumber', phone: '+237600000777', status: 'active',
      created_at: new Date(), updated_at: new Date(),
    });
    await creditWalletService.credit('vendor', closing.toString(), 5, 'adjustment', 'admin_adjustment', 'seed');
    await graceDebit(closing, 35, null); // −30
    const live = await listing(closing, 1, 'live');
    const pend = await listing(closing, 2, 'pending_review');
    const susp = await listing(closing, 3, 'suspended', { reason: 'insufficient_credits', previous_status: 'live', at: new Date() });
    for (const id of [live, pend, susp]) {
      await col(COLLECTIONS.LISTING_CONTACT).insertOne({
        _id: oid(), listing_id: id, vendor_id: closing,
        published: { whatsapp: '+237699999999', phone: '+237699999999', email: 'p@x.test', website: null, socials: [], location: null, video: null },
        pending: { whatsapp: '+237688888888', phone: null, email: null, website: null, socials: [], location: null, video: null },
      });
    }

    const closure = new RoleClosureService();
    const admin = { userId: oid().toString(), source: 'admin' as const, name: 'Verify Admin' };
    const req = await closure.request({ userId: userId.toString(), role: 'vendor', reason: 'Owner asked', actor: admin });
    await assert('the request warns `credit_debt_written_off` with amount 30', () =>
      (req.warnings ?? []).some((w) => w.code === 'credit_debt_written_off' && w.amount === 30));
    await closure.confirm(userId.toString(), 'vendor', closing.toString());
    await assert('⛔ the confirm wrote ONE adjustment row (credit_debt_written_off, +30, ref = the request) and the balance is 0', async () => {
      const rows = await CreditTransactionModel.find({ owner_id: closing, reason_code: 'credit_debt_written_off' }).lean();
      return rows.length === 1 && rows[0].type === 'adjustment' && rows[0].amount === 30 && rows[0].balance_after === 0
        && rows[0].ref === req._id.toString() && (await balanceOf(closing)) === 0 && (await ledgerSum(closing)) === 0;
    });
    await assert('every listing is archived, its suspension cleared', async () => {
      const rows = await ListingModel.find({ vendor_id: closing }).lean();
      return rows.length === 3 && rows.every((r) => r.status === 'archived' && r.archived_at && r.suspension === null);
    });
    await assert('⛔ every contact set is erased (published and pending null)', async () => {
      const rows = await ListingContactModel.find({ vendor_id: closing }).lean();
      return rows.length === 3 && rows.every((r) => r.published === null && r.pending === null);
    });

    // ─── § 4 Listing quota ─────────────────────────────────────────────────
    console.log('\n§ 4 the listing quota on a downgrade and an upgrade');
    const small = await plan('sl_provider_two', { vendor_kind: 'provider', max_active_listings: 2 });
    const large = await plan('sl_provider_four', { vendor_kind: 'provider', max_active_listings: 4 });
    const huge = await plan('sl_provider_ten', { vendor_kind: 'provider', max_active_listings: 10 });
    const q = oid();
    await col(COLLECTIONS.VENDOR).insertOne({ _id: q, user_id: oid(), kind: 'provider' });
    await setBalance(q, 50);
    const a = await listing(q, 1, 'live');
    const b = await listing(q, 2, 'live');
    const c = await listing(q, 3, 'pending_review');
    const creditSuspendedAt = new Date(Date.UTC(2026, 0, 5));
    const d = await listing(q, 4, 'suspended', { reason: 'insufficient_credits', previous_status: 'live', at: creditSuspendedAt });
    const e = await listing(q, 5, 'live');
    const draft = await listing(q, 6, 'draft');

    await putOnPlan(q, small);
    const down = await planQuotaEnforcementService.reconcileOwner('vendor', q.toString());
    await assert('⛔ a downgrade to 2 keeps the OLDEST (the pinned credit suspension takes the other slot)', async () =>
      (await statusOf(a)).status === 'live' && down.listingsSuspended === 3 && down.listingsAllowed === 2);
    await assert('⛔ the newer ones are suspended plan_quota_exceeded, each with its OWN previous status', async () => {
      const [sb, sc, se] = [await statusOf(b), await statusOf(c), await statusOf(e)];
      return [sb, sc, se].every((s) => s.status === 'suspended' && s.suspension?.reason === 'plan_quota_exceeded')
        && sb.suspension?.previous_status === 'live' && sc.suspension?.previous_status === 'pending_review'
        && se.suspension?.previous_status === 'live';
    });
    await assert('⛔ the listing suspended for insufficient_credits is untouched (reason, previous, at)', async () => {
      const sd = await statusOf(d);
      return sd.status === 'suspended' && sd.suspension?.reason === 'insufficient_credits'
        && sd.suspension.previous_status === 'live' && sd.suspension.at.getTime() === creditSuspendedAt.getTime();
    });
    await assert('a draft holds no slot and is never swept', async () => (await statusOf(draft)).status === 'draft');
    await assert('the state row stamps the listing limit', async () =>
      (await PlanQuotaStateModel.findOne({ owner_id: q }).lean())?.enforced_max_listings === 2);

    await putOnPlan(q, large);
    const up = await planQuotaEnforcementService.reconcileOwner('vendor', q.toString());
    await assert('⛔ an upgrade to 4 restores OLDEST-FIRST: b back live, c back to review, e still waiting', async () =>
      up.listingsRestored === 2 && (await statusOf(b)).status === 'live' && (await statusOf(c)).status === 'pending_review'
      && (await statusOf(e)).suspension?.reason === 'plan_quota_exceeded'
      && (await statusOf(b)).suspension === null);
    await assert('…and the credit suspension is still untouched', async () =>
      (await statusOf(d)).suspension?.at.getTime() === creditSuspendedAt.getTime());

    await setBalance(q, LISTING_REVEAL_FIRST_COST - 1);
    await putOnPlan(q, huge);
    await planQuotaEnforcementService.reconcileOwner('vendor', q.toString());
    await assert('a `live` listing restored below the first-reveal cost comes back suspended insufficient_credits', async () => {
      const se = await statusOf(e);
      return se.status === 'suspended' && se.suspension?.reason === 'insufficient_credits' && se.suspension.previous_status === 'live';
    });

    // The real trigger: an assignment → plan.activated → the consumer.
    registerPlanQuotaConsumer();
    await setBalance(q, 50);
    await col(COLLECTIONS.LISTING).updateOne({ _id: e }, { $set: { status: 'live', suspension: null } });
    await putOnPlan(q, large); // 4 slots: a, b, c, d(pinned) — e waits
    await planQuotaEnforcementService.reconcileOwner('vendor', q.toString());
    await subscriberPlanService.assignPlan('vendor', q.toString(), huge.toString());
    await assert('⛔ assignPlan → plan.activated → the consumer restores the waiting listing', async () =>
      waitFor(async () => (await statusOf(e)).status === 'live'));

    // An administrator editing the plan in place emits nothing; the stamped value is what catches it.
    await PricingPlanModel.updateOne({ _id: huge }, { $set: { max_active_listings: 1 } });
    await planQuotaReconcileWorker.runSweep();
    // One slot. The balance is 50 by now, so the sweep's funding backstop (L-10, same pass) brings
    // the credit suspension (d) back live — corrected 2026-11-07: this asserted d stayed pinned,
    // which contradicts "comes back live on its own" — and d holds the slot; the rest wait.
    await assert('⛔ an in-place edit of max_active_listings is caught by the reconcile sweep (drift on the stamp)', async () =>
      (await statusOf(a)).suspension?.reason === 'plan_quota_exceeded'
      && (await statusOf(b)).suspension?.reason === 'plan_quota_exceeded'
      && (await statusOf(e)).suspension?.reason === 'plan_quota_exceeded'
      && (await PlanQuotaStateModel.findOne({ owner_id: q }).lean())?.enforced_max_listings === 1);
    await assert('…and the funded credit suspension came back live and holds the one slot', async () => {
      const sd = await statusOf(d);
      return sd.status === 'live' && sd.suspension === null && creditSuspendedAt instanceof Date;
    });

    const sellerQ = oid();
    await col(COLLECTIONS.VENDOR).insertOne({ _id: sellerQ, user_id: oid() });
    const stray = await listing(sellerQ, 1, 'live');
    await putOnPlan(sellerQ, await plan('sl_seller_zero', { vendor_kind: 'seller', max_active_listings: 0 }));
    const sellerOutcome = await planQuotaEnforcementService.reconcileOwner('vendor', sellerQ.toString());
    await assert('a SELLER is never swept on the listing axis, whatever the plan says', async () =>
      (await statusOf(stray)).status === 'live' && sellerOutcome.listingsSuspended === 0);
  } finally {
    await sleep(200); // let fire-and-forget handlers settle before the drop
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.db?.databaseName === REQUIRED_DB) {
      await mongoose.connection.db.dropDatabase();
    }
  } catch { /* the database is disposable; the run already failed */ }
  process.exit(1);
});
