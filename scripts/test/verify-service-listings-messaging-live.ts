/**
 * verify:service-listings-messaging — a provider's leads, the opt-in and the report ticket against
 * a REAL MongoDB (SERVICE-LISTINGS-PLAN L-13, L-14, L-31). What `test:service-listings-messaging`
 * cannot prove with fakes: the lead list reads the real `customers` rows and masks them, the
 * consent door refuses a stranger, and a report becomes one `LISTING_LEAD_REPORT` ticket through
 * the real ticket service, with its metadata, and only one while it is open.
 *
 * No message is SENT here (that needs Meta / Telegram): the send path's refusals are asserted
 * where they are decided before any send — no linked chat.
 *
 * DROPS its database: refuses anywhere but `sl_messaging`, except under CI (moves to that sibling).
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/sl_messaging?replicaSet=rs0" npm run verify:service-listings-messaging
 */
import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';
import { ERROR_CODES } from '../../src/core/error-codes';
import { TicketModel } from '../../src/modules/tickets/models/ticket.model';
import { creditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { listingRevealService } from '../../src/modules/listings/domain/services/listing-reveal.service';
import { providerConsentService } from '../../src/modules/listings/domain/services/listing-consent.service';
import { listingLeadService } from '../../src/modules/listings/domain/services/listing-lead.service';
import { ListingRevealModel } from '../../src/modules/listings/models/listing-reveal.model';
import { ListingLeadModel } from '../../src/modules/listings/models/listing-lead.model';
import { ProviderContactConsentModel } from '../../src/modules/listings/models/provider-contact-consent.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27117/sl_messaging?replicaSet=rs0';
const REQUIRED_DB = 'sl_messaging';

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
async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> } | null> {
  try { await fn(); return null; } catch (err) { return err as { code?: string; details?: Record<string, unknown> }; }
}

const oid = () => new Types.ObjectId();
const col = (name: string) => mongoose.connection.db!.collection(name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  for (const m of [ListingLeadModel, ListingRevealModel, ProviderContactConsentModel]) await m.syncIndexes();

  try {
    // A provider, a live listing, one customer with a real profile and a user row.
    const vendorId = oid();
    const vendorUser = oid();
    await col(COLLECTIONS.VENDOR).insertOne({ _id: vendorId, user_id: vendorUser, kind: 'provider', status: 'active', listing_settings: null });
    await creditWalletService.credit('vendor', vendorId.toString(), 40, 'adjustment', 'admin_adjustment', 'seed');
    const listingId = oid();
    await col(COLLECTIONS.LISTING).insertOne({
      _id: listingId, vendor_id: vendorId, slug: `sl-${listingId}`, status: 'live', suspension: null,
      published: { title: 'Plumbing', company_name: 'Akwa Plumbers', category_ids: [], country: 'CM', city: 'Douala', area: 'Akwa', description: 'x'.repeat(30), description_rich: null, photo_file_ids: [], opening_hours: null },
      pending: null, review: null, last_decision: null, available_fields: ['whatsapp', 'phone'],
      published_at: new Date(), archived_at: null, vectorisation_status: 'not_started', vectorised_data_id: null, vectorisation_job: null,
      created_at: new Date(), updated_at: new Date(),
    });
    await col(COLLECTIONS.LISTING_CONTACT).insertOne({
      listing_id: listingId, vendor_id: vendorId, pending: null,
      published: { whatsapp: '+237671234531', phone: '+237233445566', email: null, website: null, socials: [], location: null, video: null },
    });
    const customerUser = oid();
    const customerId = oid();
    await col(COLLECTIONS.USER).insertOne({ _id: customerUser, email: `c-${customerUser}@example.test`, roles: ['customer'], status: 'active' });
    await col(COLLECTIONS.CUSTOMER).insertOne({ _id: customerId, user_id: customerUser, name: 'Jean-Paul Kamga', phone: '+237699887731', status: 'active', closed_at: null, preferences: { language: 'fr' } });

    // ─── § 1 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 1 the opt-in door (L-14)');
    await assert('a customer cannot set a consent toward a provider they never revealed from (404)', async () =>
      (await refusal(() => providerConsentService.set(customerId.toString(), vendorId.toString(), true, 'web')))?.code === ERROR_CODES.LISTING_LEAD_NOT_FOUND);
    await listingRevealService.reveal({ customerId: customerId.toString(), userId: customerUser.toString(), listingId: listingId.toString(), field: 'phone', channel: 'web' });
    await assert('the first reveal from a provider asks the opt-in question exactly once', async () =>
      (await providerConsentService.askOnce(customerId.toString(), vendorId.toString())) === true
      && (await providerConsentService.askOnce(customerId.toString(), vendorId.toString())) === false);
    const granted = await providerConsentService.set(customerId.toString(), vendorId.toString(), true, 'web');
    await assert('granting works once a lead exists, and names the business by its listing', async () =>
      granted.consent === 'granted' && granted.businessName === 'Akwa Plumbers');

    // ─── § 2 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 2 the lead list (L-13)');
    const page = await listingLeadService.list(vendorId.toString(), { page: 1, limit: 20 });
    const row = page.data[0];
    await assert('one lead, masked: "Jean-Paul K." and "+237 ••• ••• •31", the reveal listed', async () =>
      page.meta.total === 1 && row.customer.displayName === 'Jean-Paul K.' && row.customer.maskedPhone === '+237 ••• ••• •31'
      && row.fields.length === 1 && row.fields[0].field === 'phone' && row.fields[0].cost === 7 && !row.fields[0].refunded);
    await assert('⛔ the row carries neither the customer\'s number nor their name in full', async () =>
      !JSON.stringify(page).includes('699887731') && !JSON.stringify(page).includes('Kamga'));
    await assert('opted in but no linked chat: both message buttons off, 3 left', async () =>
      row.consent === 'granted' && !row.callMeAvailable && !row.freeTextAvailable && row.messagesLeft === 3);
    await assert('call-me with no linked chat → 422 LISTING_MESSAGE_CHANNEL_UNAVAILABLE, and nothing charged', async () => {
      const before = (await creditWalletService.getBalance('vendor', vendorId.toString()));
      const e = await refusal(() => listingLeadService.callMe(vendorId.toString(), row.id));
      return e?.code === ERROR_CODES.LISTING_MESSAGE_CHANNEL_UNAVAILABLE && (await creditWalletService.getBalance('vendor', vendorId.toString())) === before;
    });
    await assert('another provider cannot read or act on this lead (404)', async () =>
      (await refusal(() => listingLeadService.callMe(oid().toString(), row.id)))?.code === ERROR_CODES.LISTING_LEAD_NOT_FOUND);

    // ─── § 3 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 3 the report (L-31)');
    const revealId = (await ListingRevealModel.findOne({ listing_id: listingId }).lean())!._id.toString();
    const out = await listingLeadService.report(vendorId.toString(), vendorUser.toString(), row.id, {
      wants: ['refund', 'check_customer'], revealIds: [revealId], reason: 'Five numbers, one person, same afternoon',
    });
    const ticket = await TicketModel.findById(out.ticketId).lean();
    await assert('one LISTING_LEAD_REPORT ticket on the lead, opened by the provider, with its metadata', async () =>
      ticket?.type === 'LISTING_LEAD_REPORT' && ticket.entity_type === 'LISTING_LEAD' && ticket.entity_id === row.id
      && ticket.created_by_role === 'vendor' && (ticket.metadata as Record<string, unknown>)?.listingId === listingId.toString()
      && JSON.stringify((ticket.metadata as Record<string, unknown>)?.revealIds) === JSON.stringify([revealId])
      && out.ticketNumber === `#${out.ticketId.slice(-6).toUpperCase()}`);
    await assert('the lead row now says a report is open', async () =>
      (await listingLeadService.list(vendorId.toString(), { page: 1, limit: 20 })).data[0].reportOpen === true);
    await assert('a second report while it is open → 422 LISTING_REPORT_INVALID (report_open)', async () => {
      const e = await refusal(() => listingLeadService.report(vendorId.toString(), vendorUser.toString(), row.id, { wants: ['check_customer'], revealIds: [], reason: 'Checking once more please' }));
      return e?.code === ERROR_CODES.LISTING_REPORT_INVALID && e.details?.reason === 'report_open'
        && (await TicketModel.countDocuments({ entity_id: row.id })) === 1;
    });

    // ─── § 4 ─────────────────────────────────────────────────────────────────
    console.log('\n§ 4 withdrawing the opt-in');
    const refused = await providerConsentService.set(customerId.toString(), vendorId.toString(), false, 'bot');
    await assert('a withdrawal is "revoked", history kept, and the list says so', async () =>
      refused.consent === 'revoked' && !!refused.grantedAt && !!refused.revokedAt
      && (await listingLeadService.list(vendorId.toString(), { page: 1, limit: 20 })).data[0].consent === 'revoked');
    await assert('free text after a withdrawal → 422 LISTING_MESSAGE_CONSENT_REQUIRED', async () =>
      (await refusal(() => listingLeadService.message(vendorId.toString(), row.id, 'Bonjour')))?.code === ERROR_CODES.LISTING_MESSAGE_CONSENT_REQUIRED);
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
