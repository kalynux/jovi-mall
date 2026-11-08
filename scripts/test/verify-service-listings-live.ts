/**
 * verify:service-listings — the reveal, the refund and the block against a REAL MongoDB replica
 * set (SERVICE-LISTINGS-PLAN § The reveal, L-10, L-25, L-29). What the DB-free
 * `test:service-listings-reveal` cannot prove: that the debit, the lead, the reveal row and the
 * ledger row commit TOGETHER, that two simultaneous taps charge once, that the unique and
 * partial indexes hold under a race, and that a credit brings a credit-paused listing back.
 *
 * Needs a replica set (transactions) and Redis (the funding sweep's lock is not used here, but
 * the event bus' consumers may touch it). It DROPS its database, so it refuses to run anywhere
 * but `sl_reveal` — except under CI, where it moves itself to that sibling of `jovi_mall_ci`.
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/sl_reveal?replicaSet=rs0" npm run verify:service-listings
 */
import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';
import { ERROR_CODES } from '../../src/core/error-codes';
import { CreditWalletModel } from '../../src/modules/billing/models/credit-wallet.model';
import { CreditTransactionModel } from '../../src/modules/billing/models/credit-transaction.model';
import { creditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { ListingModel } from '../../src/modules/listings/models/listing.model';
import { ListingContactModel } from '../../src/modules/listings/models/listing-contact.model';
import { ListingLeadModel } from '../../src/modules/listings/models/listing-lead.model';
import { ListingRevealModel } from '../../src/modules/listings/models/listing-reveal.model';
import { ListingRevealBlockModel } from '../../src/modules/listings/models/listing-reveal-block.model';
import { listingRevealService } from '../../src/modules/listings/domain/services/listing-reveal.service';
import { listingReportAdminService } from '../../src/modules/listings/domain/services/listing-report-admin.service';
import { registerListingSubscribers } from '../../src/modules/listings';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27117/sl_reveal?replicaSet=rs0';
const REQUIRED_DB = 'sl_reveal';

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
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (err) { return (err as { code?: string }).code ?? (err as Error).message; }
}

const oid = () => new Types.ObjectId();
const col = (name: string) => mongoose.connection.db!.collection(name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}
const balanceOf = async (vendorId: Types.ObjectId) =>
  (await CreditWalletModel.findOne({ owner_type: 'vendor', owner_id: vendorId }).lean())?.balance ?? NaN;
const ledgerSum = async (vendorId: Types.ObjectId) =>
  (await CreditTransactionModel.find({ owner_type: 'vendor', owner_id: vendorId }).lean()).reduce((s, r) => s + r.amount, 0);
const statusOf = async (id: Types.ObjectId) =>
  (await ListingModel.findById(id).lean()) as unknown as { status: string; suspension: { reason: string } | null };

const ADMIN = { userId: oid().toString(), source: 'admin' as const, name: 'Verify Admin' };

/** A provider with a balance, one live listing and its approved contacts. */
async function provider(balance: number, settings: Record<string, unknown> | null = null) {
  const vendorId = oid();
  const userId = oid();
  await col(COLLECTIONS.VENDOR).insertOne({ _id: vendorId, user_id: userId, kind: 'provider', status: 'active', listing_settings: settings });
  if (balance !== 0) await creditWalletService.credit('vendor', vendorId.toString(), balance, 'adjustment', 'admin_adjustment', 'seed');
  const listingId = oid();
  await col(COLLECTIONS.LISTING).insertOne({
    _id: listingId, vendor_id: vendorId, slug: `sl-${listingId}`, status: 'live', suspension: null,
    published: { title: 'Plumbing', company_name: 'Akwa Plumbers', category_ids: [], country: 'CM', city: 'Douala', area: 'Akwa', description: 'x'.repeat(30), description_rich: null, photo_file_ids: [], opening_hours: null },
    pending: null, review: null, last_decision: null,
    available_fields: ['whatsapp', 'phone', 'email', 'website'],
    published_at: new Date(), archived_at: null, vectorisation_status: 'not_started', vectorised_data_id: null, vectorisation_job: null,
    created_at: new Date(), updated_at: new Date(),
  });
  await col(COLLECTIONS.LISTING_CONTACT).insertOne({
    listing_id: listingId, vendor_id: vendorId, pending: null,
    published: { whatsapp: '+237671234531', phone: '+237233445566', email: 'hello@akwa.cm', website: 'https://akwa.cm', socials: [], location: null, video: null },
  });
  return { vendorId, userId, listingId };
}
const reveal = (p: { listingId: Types.ObjectId }, customerId: string, field: string) =>
  listingRevealService.reveal({ customerId, userId: oid().toString(), listingId: p.listingId.toString(), field: field as never, channel: 'web' });

async function main(): Promise<void> {
  const underCi = !!process.env.CI;
  const dbName = new URL(MONGO_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
  if (!underCi && dbName !== REQUIRED_DB) {
    console.error(`Refusing to run: this suite DROPS its database, and '${dbName}' is not '${REQUIRED_DB}'.`);
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, underCi ? { dbName: REQUIRED_DB } : {});
  console.log(`Connected (database ${mongoose.connection.db?.databaseName})`);
  for (const name of mongoose.modelNames()) await mongoose.model(name).init().catch(() => undefined);
  for (const m of [ListingLeadModel, ListingRevealModel, ListingRevealBlockModel, ListingContactModel]) await m.syncIndexes();
  registerListingSubscribers();

  try {
    // ─── § 1 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 1 one reveal is one transaction');
    const p = await provider(20);
    const c1 = oid().toString();
    const first = await reveal(p, c1, 'whatsapp');
    const row = await ListingRevealModel.findOne({ listing_id: p.listingId, field: 'whatsapp' }).lean();
    const ledger = await CreditTransactionModel.findOne({ owner_id: p.vendorId, reason_code: 'listing_reveal' }).lean();
    await assert('7 debited; the reveal row, its ledger row and the lead all exist', async () =>
      first.result.cost === 7 && (await balanceOf(p.vendorId)) === 13 && !!row && !!ledger
      && row.ledger_ref === ledger._id.toString() && ledger.ref === row._id.toString()
      && (await ListingLeadModel.countDocuments({ listing_id: p.listingId })) === 1);
    await assert('⛔ no contact value was written anywhere but listing_contacts', async () => {
      const dump = JSON.stringify([await ListingRevealModel.find({}).lean(), await ListingLeadModel.find({}).lean(), await CreditTransactionModel.find({}).lean()]);
      return !dump.includes('671234531') && !dump.includes('akwa.cm');
    });
    await assert('the wallet and its ledger agree', async () => (await ledgerSum(p.vendorId)) === (await balanceOf(p.vendorId)));

    // ─── § 2 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 2 two taps at once charge once');
    const before = await balanceOf(p.vendorId);
    const both = await Promise.allSettled([reveal(p, c1, 'phone'), reveal(p, c1, 'phone')]);
    const ok = both.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof reveal>>>>;
    await assert('⛔ two simultaneous taps on one field: ONE reveal row, ONE debit of 4', async () =>
      (await ListingRevealModel.countDocuments({ listing_id: p.listingId, field: 'phone' })) === 1
      && (await balanceOf(p.vendorId)) === before - 4
      && ok.filter((r) => r.value.result.charged).length === 1);
    await assert('the wallet and its ledger still agree', async () => (await ledgerSum(p.vendorId)) === (await balanceOf(p.vendorId)));

    // ─── § 3 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 3 out of credits, grace, and back on a top-up');
    const q = await provider(10); // 10 − 7 = 3 < 7 → suspended
    const cq = oid().toString();
    await reveal(q, cq, 'whatsapp');
    await assert('a reveal that leaves 3 suspends the listing insufficient_credits', async () => {
      const s = await statusOf(q.listingId);
      return s.status === 'suspended' && s.suspension?.reason === 'insufficient_credits';
    });
    await assert('a NEW customer is refused, neutrally, and charged nothing', async () =>
      (await refusal(() => reveal(q, oid().toString(), 'phone'))) === ERROR_CODES.LISTING_UNREACHABLE && (await balanceOf(q.vendorId)) === 3);
    const grace = await reveal(q, cq, 'phone');
    await assert('the ENGAGED customer is served into debt (3 − 4 = −1), the row marked charged_into_debt', async () =>
      grace.result.charged && (await balanceOf(q.vendorId)) === -1
      && (await ListingRevealModel.findOne({ listing_id: q.listingId, field: 'phone' }).lean())?.charged_into_debt === true);
    await creditWalletService.credit('vendor', q.vendorId.toString(), 20, 'topup', 'topup_purchase', 'verify');
    await assert('a top-up pays the debt first (−1 + 20 = 19) and the listing comes back live on its own', async () =>
      (await balanceOf(q.vendorId)) === 19 && waitFor(async () => (await statusOf(q.listingId)).status === 'live'));

    // ─── § 4 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 4 the block (L-29)');
    const r = await provider(50);
    const cr = oid().toString();
    const blocks = await Promise.allSettled([
      listingReportAdminService.blockCustomer(r.listingId.toString(), cr, { reason: 'Drainer' }, ADMIN),
      listingReportAdminService.blockCustomer(r.listingId.toString(), cr, { reason: 'Drainer' }, ADMIN),
    ]);
    await assert('⛔ two simultaneous blocks: one placed, one 409 LISTING_REVEAL_BLOCK_EXISTS (the partial unique index)', async () =>
      blocks.filter((b) => b.status === 'fulfilled').length === 1
      && blocks.some((b) => b.status === 'rejected' && (b.reason as { code?: string }).code === ERROR_CODES.LISTING_REVEAL_BLOCK_EXISTS)
      && (await ListingRevealBlockModel.countDocuments({ listing_id: r.listingId, lifted_at: null })) === 1);
    await assert('the blocked customer is refused neutrally and charged nothing', async () =>
      (await refusal(() => reveal(r, cr, 'phone'))) === ERROR_CODES.LISTING_UNREACHABLE && (await balanceOf(r.vendorId)) === 50);
    await listingReportAdminService.liftBlock(r.listingId.toString(), cr, 'Checked', ADMIN);
    await assert('after the lift the customer reveals normally, and a new block may be placed later', async () => {
      const out = await reveal(r, cr, 'phone');
      const again = await listingReportAdminService.blockCustomer(r.listingId.toString(), cr, { reason: 'Again' }, ADMIN);
      return out.result.charged && !!again.activeBlock && (await ListingRevealBlockModel.countDocuments({ listing_id: r.listingId })) === 2;
    });

    // ─── § 5 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 5 the refund (L-25)');
    const target = await ListingRevealModel.findOne({ listing_id: r.listingId, customer_id: new Types.ObjectId(cr) }).lean();
    const beforeRefund = await balanceOf(r.vendorId);
    const refunds = await Promise.allSettled([
      listingReportAdminService.refundReveal(target!._id.toString(), { note: 'Drain confirmed' }, ADMIN),
      listingReportAdminService.refundReveal(target!._id.toString(), { note: 'Drain confirmed' }, ADMIN),
    ]);
    await assert('⛔ two simultaneous refunds of one reveal credit it ONCE', async () =>
      refunds.filter((x) => x.status === 'fulfilled').length === 1
      && (await balanceOf(r.vendorId)) === beforeRefund + target!.cost
      && (await CreditTransactionModel.countDocuments({ owner_id: r.vendorId, reason_code: 'listing_reveal_refund' })) === 1);
    const stamped = await ListingRevealModel.findById(target!._id).lean();
    const refundRow = await CreditTransactionModel.findOne({ owner_id: r.vendorId, reason_code: 'listing_reveal_refund' }).lean();
    await assert('the reveal is stamped with the refund ledger row and the administrator', async () =>
      stamped?.refund?.ledger_ref === refundRow?._id.toString() && stamped?.refund?.by_name === 'Verify Admin'
      && refundRow?.type === 'refund' && refundRow?.ref === target!._id.toString());
    await assert('the wallet and its ledger agree after everything', async () => (await ledgerSum(r.vendorId)) === (await balanceOf(r.vendorId)));
  } finally {
    await sleep(200);
    if (mongoose.connection.db?.databaseName === REQUIRED_DB) await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
