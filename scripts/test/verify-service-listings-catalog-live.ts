/**
 * verify:service-listings-catalog — informational service listings against REAL Mongo
 * (walk-order step 3 and the jovi-mall halves of steps 4 and 5).
 *
 * NEEDS Mongo WITH TRANSACTIONS (a replica set). Run against a throwaway database — it drops the
 * database it ran in at the end, pass or fail, so it refuses a database whose name does not look
 * like a scratch one:
 *
 *   MONGO_URI=mongodb://127.0.0.1:27117/sl_catalog?replicaSet=rs0 \
 *     npx ts-node scripts/migrate-service-listings-indexes.ts   # the $text index
 *   MONGO_URI=… npm run verify:service-listings-catalog
 *
 * Drives the services directly (no HTTP server). The vectoriser and YouTube are stubbed — no
 * network. What it proves that `test:service-listings-catalog` (DB-free) structurally cannot:
 *
 *   - the fee is a REAL ledger row, and every refund lands (withdraw, reject) — balance + ledger;
 *   - approve really copies BOTH collections in one transaction, and `available_fields` holds names;
 *   - a revision really leaves `published` (and the public read) untouched while it waits;
 *   - approval below the first-reveal cost really lands `suspended / insufficient_credits`, and a
 *     credit + reconcile really restores it to its exact previous status — and never touches an
 *     administrator's suspension;
 *   - the public reads (list, `$text`, by-ids freshness gate, detail) return only live listings
 *     and never a contact value;
 *   - the vectoriser callback's claim is a real compare-and-set.
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';

import { eventBus } from '../../src/core/events/event-bus';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { FileModel } from '../../src/modules/catalog/models/file.model';
import { FileReferenceModel } from '../../src/modules/catalog/models/file-reference.model';
import { CreditTransactionModel } from '../../src/modules/billing/models/credit-transaction.model';
import { creditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { VECTORISATION_COST, LISTING_REVEAL_FIRST_COST } from '../../src/modules/billing/config/credit.config';
import { categoryCatalogCache } from '../../src/modules/categories/services/category-catalog.cache';
import { ListingModel } from '../../src/modules/listings/models/listing.model';
import { listingContactRepository } from '../../src/modules/listings/repositories/listing-contact.repository';
import { listingRepository } from '../../src/modules/listings/repositories/listing.repository';
import { ListingProviderService } from '../../src/modules/listings/domain/services/listing-provider.service';
import { ListingReviewService } from '../../src/modules/listings/domain/services/listing-review.service';
import { ListingFundingService } from '../../src/modules/listings/domain/services/listing-funding.service';
import { ListingVectorisationService } from '../../src/modules/listings/domain/services/listing-vectorisation.service';
import { ListingSettingsService } from '../../src/modules/listings/domain/services/listing-settings.service';
import { PublicListingService } from '../../src/modules/listings/domain/services/public-listing.service';
import { registerListingSubscribers } from '../../src/modules/listings';
import { ListingWriteSchema } from '../../src/modules/listings/validators/listing.validator';
import type { ListingVectoriserTransport, VectoriserVerdict } from '../../src/modules/listings/domain/services/listing-vectoriser.client';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27117/sl_catalog?replicaSet=rs0';

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

const codeOf = (err: unknown): string | undefined => (err as { code?: string } | undefined)?.code;
async function thrownAsync(fn: () => Promise<unknown>): Promise<unknown> {
    try { await fn(); } catch (err) { return err; }
    return undefined;
}

// ─── Stubs: the vectoriser and YouTube, recorded ─────────────────────────────

const posts: Array<{ path: string; body: any }> = [];
let jobCounter = 0;
const transport: ListingVectoriserTransport = {
    async post<T>(path: '' | '/delete', body: unknown): Promise<VectoriserVerdict<T>> {
        posts.push({ path, body });
        if (path === '/delete') return { ok: true, body: { success: true } as T };
        const id = (body as { listing_id: string }).listing_id;
        return { ok: true, body: { job_id: `job-${++jobCounter}`, accepted: [id], rejected: [] } as T };
    },
};

const pending: Array<Promise<unknown>> = [];
const track = <T>(p: Promise<T>): Promise<T> => { pending.push(p); return p; };
async function flush(): Promise<void> {
    while (pending.length) await Promise.allSettled(pending.splice(0));
    await new Promise((r) => setTimeout(r, 50));
}

const realVec = new ListingVectorisationService(listingRepository, transport);
const vec = {
    index: (id: string, o: { billed: boolean }) => track(realVec.index(id, o)),
    deindex: (id: string, v: string | null) => track(realVec.deindex(id, v)),
};

const slotLimit = { value: 3 };
const entitlements = {
    async assertCanAddListings(_vendorId: string, current: number, adding = 1): Promise<void> {
        if (current + adding > slotLimit.value) {
            throw Object.assign(new Error('limit'), { code: 'BILLING_LIMIT_EXCEEDED', statusCode: 403 });
        }
    },
};

const funding = new ListingFundingService(listingRepository, creditWalletService, vec as never);
const oembed = { check: async () => 'watchable' as const };
const provider = new ListingProviderService(
    undefined, undefined, undefined, entitlements as never, undefined, oembed as never,
    { reconcileVendor: (v: string) => track(funding.reconcileVendor(v)) } as never, vec as never,
);
/** Bodies go through the controller's own schema first, exactly as over HTTP. */
const prov = {
    create: (vendorId: string, body: unknown) => provider.create(vendorId, ListingWriteSchema.parse(body)),
    update: (vendorId: string, id: string, body: unknown) => provider.update(vendorId, id, ListingWriteSchema.parse(body)),
};
const review = new ListingReviewService(undefined, undefined, undefined, vec as never);
const settings = new ListingSettingsService();
const publicReads = new PublicListingService();

const ADMIN = { userId: new Types.ObjectId().toString(), source: 'admin' as const, name: 'Verify Admin' };

/** Contact values that must never surface on a public read. */
const SECRET = {
    whatsapp: '+237699111222',
    phone: '+237699333444',
    email: 'secret.owner@poison.example',
    website: 'https://poison-site.example',
    video: 'https://youtu.be/POISONVIDEO1',
    address: '12 Rue Secrete, Akwa',
};
const leaks = (value: unknown): string[] => {
    const json = JSON.stringify(value);
    return Object.values(SECRET).filter((s) => json.includes(s)).concat(json.includes('9.7654321') ? ['lng'] : []);
};

async function balanceOf(vendorId: string): Promise<number> {
    return creditWalletService.getBalance('vendor', vendorId);
}

async function seedVendor(credits: number): Promise<string> {
    const id = new Types.ObjectId();
    // Raw insert: the listings module reads a vendor's `kind`, `status` and `listing_settings` only.
    await VendorModel.collection.insertOne({ _id: id, user_id: new Types.ObjectId(), kind: 'provider', status: 'active', display_name: 'Verify Provider' });
    if (credits > 0) await creditWalletService.credit('vendor', id.toString(), credits, 'topup', 'topup_purchase', `seed-${id}`);
    return id.toString();
}

const fullContent = (title: string) => ({
    title,
    companyName: 'Jean Plomberie',
    categories: [{ name: 'Plumbing Services' }],
    country: 'CM',
    city: 'Douala',
    area: 'Akwa',
    description: 'Leaks, pipes and water heaters — fast, clean and guaranteed work.',
    openingHours: [{ day: 'monday' as const, openTime: '08:00', closeTime: '17:00', isClosed: false }],
});
const fullContacts = {
    whatsapp: SECRET.whatsapp,
    phone: SECRET.phone,
    email: SECRET.email,
    website: SECRET.website,
    location: {
        formatted_address: SECRET.address,
        coordinates: { type: 'Point' as const, coordinates: [9.7654321, 4.0512345] as [number, number] },
        provider: 'nominatim' as const,
    },
    video: { url: SECRET.video },
};

async function main(): Promise<void> {
    const dbName = new URL(MONGO_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
    // Under CI the URI names the SHARED `jovi_mall_ci`, which later suites count rows in: move to a
    // sibling database this suite owns and drops (the verify-refund-fees pattern).
    const ciDb = process.env.CI ? 'sl_catalog_ci' : null;
    if (!ciDb && !/^sl_|verify|test/i.test(dbName)) {
        console.error(`Refusing to run against "${dbName}": this suite DROPS its database. Use a scratch one (sl_catalog).`);
        process.exit(2);
    }
    await mongoose.connect(MONGO_URI, ciDb ? { dbName: ciDb } : {});
    console.log(`Connected to ${dbName}`);
    await ListingModel.syncIndexes(); // the $text index, if the migration was not run first
    await FileReferenceModel.syncIndexes();
    categoryCatalogCache.invalidate();

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for (const type of ['listing.submitted', 'listing.approved', 'listing.rejected', 'listing.suspended', 'listing.resumed', 'quota.capacity_freed']) {
        eventBus.subscribe(type, (e) => { events.push({ type, payload: e.payload }); }, `verify.${type}`);
    }
    const saw = (type: string, listingId: string, extra: Record<string, unknown> = {}) =>
        events.some((e) => e.type === type && (e.payload.listingId === listingId || e.payload.ownerId === listingId)
            && Object.entries(extra).every(([k, v]) => e.payload[k] === v));

    try {
        // ─── 1. Create → edit → submit ──────────────────────────────────────
        console.log('\n§ 1 create → edit → submit (fee debited, real ledger row)');
        const v1 = await seedVendor(100);
        const photo = await FileModel.create({
            key: `vendors/${v1}/photo-1.png`, provider: 'local', mimeType: 'image/png', size: 1234,
            originalName: 'shopfront.png', ownerType: 'vendor', ownerId: new Types.ObjectId(v1),
        });

        const draft = await prov.create(v1, { content: { title: 'Plumbing repairs Douala' } });
        const id1 = draft.id;
        assert('create: a draft with a slug from the first title', () => draft.status === 'draft' && draft.slug === 'plumbing-repairs-douala');

        const edited = await prov.update(v1, id1, {
            content: { ...fullContent('Plumbing repairs Douala'), photoFileIds: [photo._id.toString()] },
            contacts: fullContacts,
        });
        assert('edit: the working copy holds the content and the provider sees their own contacts', () =>
            edited.pending?.companyName === 'Jean Plomberie' && edited.contacts.pending?.whatsapp === SECRET.whatsapp
            && edited.contacts.pending?.video?.host === 'youtube' && edited.pending?.categories.length === 1);
        const ref = await FileReferenceModel.findOne({ fileId: photo._id, entityId: new Types.ObjectId(id1), deletedAt: null }).lean();
        assert('the photo is referenced on file_references (entityType listing, field photos)', () =>
            (ref as any)?.entityType === 'listing' && (ref as any)?.field === 'photos');
        const strangerFile = await FileModel.create({ key: 'vendors/x/y.png', provider: 'local', mimeType: 'image/png', size: 1, ownerType: 'vendor', ownerId: new Types.ObjectId() });
        const steal = await thrownAsync(() => prov.update(v1, id1, { content: { photoFileIds: [strangerFile._id.toString()] } }));
        assert('⛔ another vendor\'s file is refused (403) — no IDOR through photoFileIds', () =>
            codeOf(steal) === 'CATALOG_PRODUCT_ACCESS_DENIED');

        const before = await balanceOf(v1);
        const submitted = await provider.submit(v1, id1);
        await flush();
        const listing1 = await ListingModel.findById(id1).lean();
        const feeRow = await CreditTransactionModel.findById(listing1?.review?.index_fee_ref).lean();
        assert('⛔ submit: status pending_review', () => submitted.status === 'pending_review');
        assert('⛔ the fee is a real ledger row (debit, vectorisation, ref = listingId) named by review.index_fee_ref', () =>
            !!feeRow && feeRow.type === 'debit' && feeRow.reason_code === 'vectorisation' && feeRow.ref === id1
            && feeRow.amount === -VECTORISATION_COST);
        assert('listing.submitted was emitted', () => saw('listing.submitted', id1));
        const afterSubmit = await balanceOf(v1);
        assert('⛔ the balance dropped by exactly the fee', () => afterSubmit === before - VECTORISATION_COST);
        const editLocked = await thrownAsync(() => prov.update(v1, id1, { content: { title: 'Changed' } }));
        assert('⛔ PATCH while pending_review → 409 LISTING_STATUS_CONFLICT', () => codeOf(editLocked) === 'LISTING_STATUS_CONFLICT');
        assert('a contact typed into the description would have been pre-flagged (none here)', () =>
            Array.isArray(listing1?.review?.preflags) && listing1!.review!.preflags.length === 0);

        // ─── 2. Approve ─────────────────────────────────────────────────────
        console.log('\n§ 2 approve — both collections, one transaction, names only');
        const approved = await review.approve(id1, ADMIN);
        await flush();
        const l1 = await ListingModel.findById(id1).lean();
        const c1 = await listingContactRepository.getForOwner(id1, v1);
        assert('⛔ status live, published set, pending/review cleared, published_at stamped', () =>
            approved.status === 'live' && !!l1?.published && l1.pending === null && l1.review === null && !!l1.published_at);
        assert('⛔ contacts copied pending → published in the same approval', () =>
            c1?.published?.whatsapp === SECRET.whatsapp && c1?.pending === null);
        assert('⛔ available_fields are the NAMES of the published contacts', () =>
            JSON.stringify(l1?.available_fields) === JSON.stringify(['whatsapp', 'phone', 'email', 'website', 'location', 'video']));
        assert('the decision is admin-stamped (source admin + name snapshot)', () =>
            l1?.last_decision?.decision === 'approved' && l1.last_decision.by_source === 'admin' && l1.last_decision.by_name === 'Verify Admin');
        const indexPost = posts.find((p) => p.path === '' && p.body.listing_id === id1);
        assert('⛔ the re-index was sent with kind listing and NO contact value', () =>
            !!indexPost && indexPost.body.kind === 'listing' && leaks(indexPost.body).length === 0);
        assert('the claim ticket was written (billed: the fee paid at submit)', () =>
            l1?.vectorisation_status === 'pending' && l1.vectorisation_job?.billed === true);
        const cb = await realVec.applyCallbackResults(l1!.vectorisation_job!.jobId, [{ listing_id: id1, status: 'completed', vectorised_id: id1 }]);
        const dup = await realVec.applyCallbackResults(l1!.vectorisation_job!.jobId, [{ listing_id: id1, status: 'completed', vectorised_id: id1 }]);
        const l1b = await ListingModel.findById(id1).lean();
        assert('⛔ the callback completes once; a re-delivery is ignored (CAS on the claim ticket)', () =>
            cb.completed === 1 && dup.ignored.length === 1 && l1b?.vectorisation_status === 'completed' && l1b.vectorised_data_id === id1);
        assert('listing.approved was emitted', () => saw('listing.approved', id1));

        // ─── 3. Public reads ────────────────────────────────────────────────
        console.log('\n§ 3 public reads — only live, never a contact');
        const page = await publicReads.list({ page: 1, limit: 20 });
        const detail = await publicReads.bySlug(l1b!.slug);
        assert('the live listing is listed, kind listing, with its photo as a FileDetail', () =>
            page.data.length === 1 && page.data[0].id === id1 && page.data[0].kind === 'listing' && page.data[0].photo?.id === photo._id.toString());
        assert('⛔ no contact value on the list or the detail', () => leaks(page).length === 0 && leaks(detail).length === 0);
        const textHit = await publicReads.list({ q: 'plumbing', page: 1, limit: 20 });
        const textMiss = await publicReads.list({ q: 'bakery', page: 1, limit: 20 });
        assert('⛔ $text search finds it by title word, and not by an unrelated one', () =>
            textHit.data.some((c) => c.id === id1) && textMiss.data.length === 0);
        const byCity = await publicReads.list({ city: 'douala', area: 'AKWA', page: 1, limit: 20 });
        const byPartialCity = await publicReads.list({ city: 'doua', page: 1, limit: 20 });
        assert('city / area match case-insensitively and EXACTLY (no substring)', () =>
            byCity.data.length === 1 && byPartialCity.data.length === 0);
        const byCategory = await publicReads.list({ category: 'plumbing-services', page: 1, limit: 20 });
        const unknownCategory = await publicReads.list({ category: 'no-such-shelf', page: 1, limit: 20 });
        assert('the category filter resolves a slug; an unknown one is an empty shelf', () =>
            byCategory.data.length === 1 && unknownCategory.data.length === 0);

        // ─── 4. Revision on a live listing ──────────────────────────────────
        console.log('\n§ 4 revision — published untouched while it waits; reject refunds');
        await prov.update(v1, id1, { content: { title: 'Plumbing and heating Douala' }, contacts: { whatsapp: '+237677000999' } });
        const rev = await ListingModel.findById(id1).lean();
        const revContacts = await listingContactRepository.getForOwner(id1, v1);
        assert('⛔ the revision lives in pending; published and the live status are unchanged', () =>
            rev?.status === 'live' && rev.published?.title === 'Plumbing repairs Douala' && rev.pending?.title === 'Plumbing and heating Douala'
            && rev.review?.state === 'editing');
        assert('⛔ a contact edit is part of the revision; the published contact is unchanged', () =>
            revContacts?.published?.whatsapp === SECRET.whatsapp && revContacts?.pending?.whatsapp === '+237677000999');
        assert('the slug did not move after the first approval', () => rev?.slug === l1b?.slug);
        const stillOld = await publicReads.bySlug(l1b!.slug);
        assert('the public detail still shows the approved title', () => stillOld.title === 'Plumbing repairs Douala');

        const b0 = await balanceOf(v1);
        await provider.submit(v1, id1);
        await flush();
        const b1 = await balanceOf(v1);
        await review.reject(id1, ['The phone number appears in a photo.'], ADMIN);
        await flush();
        const b2 = await balanceOf(v1);
        const afterReject = await ListingModel.findById(id1).lean();
        assert('⛔ the revision fee was debited, and the rejection refunded it', () =>
            b1 === b0 - VECTORISATION_COST && b2 === b0);
        const refundRow = await CreditTransactionModel.findOne({ ref: id1, type: 'refund', reason_code: 'vectorisation' }).lean();
        assert('the refund is a real ledger row (refund, vectorisation, ref = listingId)', () => !!refundRow && refundRow.amount === VECTORISATION_COST);
        assert('⛔ a rejected revision leaves the listing live and published unchanged', () =>
            afterReject?.status === 'live' && afterReject.review?.state === 'rejected'
            && afterReject.published?.title === 'Plumbing repairs Douala' && afterReject.last_decision?.decision === 'rejected');
        assert('listing.rejected was emitted', () => saw('listing.rejected', id1));

        const discarded = await provider.discardRevision(v1, id1);
        const afterDiscard = await listingContactRepository.getForOwner(id1, v1);
        assert('discard: the revision and its pending contacts are gone; published stays', () =>
            discarded.pending === null && discarded.review === null && afterDiscard?.pending === null
            && afterDiscard?.published?.whatsapp === SECRET.whatsapp);

        // ─── 5. Withdraw ────────────────────────────────────────────────────
        console.log('\n§ 5 withdraw before a decision refunds the fee');
        const d2 = await prov.create(v1, { content: fullContent('Electrician Bonaberi'), contacts: { phone: '+237655000111' } });
        const w0 = await balanceOf(v1);
        await provider.submit(v1, d2.id);
        await flush();
        const w1 = await balanceOf(v1);
        const withdrawn = await provider.withdraw(v1, d2.id);
        await flush();
        const w2 = await balanceOf(v1);
        assert('⛔ withdraw: back to draft/editing and the fee is returned', () =>
            withdrawn.status === 'draft' && withdrawn.review?.state === 'editing' && w1 === w0 - VECTORISATION_COST && w2 === w0);
        const byIds = await publicReads.byIds([id1, d2.id, new Types.ObjectId().toString()]);
        assert('⛔ by-ids: the live one is returned, the draft and an unknown id are `missing`, order kept', () =>
            byIds.data.length === 1 && byIds.data[0].id === id1 && byIds.missing.length === 2 && byIds.missing[0] === d2.id);

        // ─── 6. Approval with a wallet under the first-reveal cost ─────────
        console.log('\n§ 6 approval below the first-reveal cost → suspended, and back on a credit');
        const v2 = await seedVendor(VECTORISATION_COST + 2); // after the fee: 2 < FIRST
        const l2 = await prov.create(v2, { content: fullContent('Tailor in Bonapriso'), contacts: { whatsapp: '+237655222333' } });
        await provider.submit(v2, l2.id);
        await flush();
        const ap2 = await review.approve(l2.id, ADMIN);
        await flush();
        const l2a = await ListingModel.findById(l2.id).lean();
        assert(`⛔ balance ${await balanceOf(v2)} < ${LISTING_REVEAL_FIRST_COST}: approved straight into suspended / insufficient_credits`, () =>
            ap2.status === 'suspended' && l2a?.suspension?.reason === 'insufficient_credits' && l2a.suspension.previous_status === 'live'
            && !!l2a.published);
        const notPublic = await publicReads.byIds([l2.id]);
        assert('a credit-suspended listing is not public', () => notPublic.missing.length === 1);

        // The subscriber, wired to the STUBBED funding (no network): production passes nothing.
        registerListingSubscribers({ reconcileIfProvider: (v: string) => track(funding.reconcileIfProvider(v)) });
        await creditWalletService.credit('vendor', v2, 50, 'topup', 'topup_purchase', 'verify-topup');
        await new Promise((r) => setTimeout(r, 300)); // the subscriber is fire-and-forget
        await flush();
        const l2b = await ListingModel.findById(l2.id).lean();
        assert('⛔ a top-up (billing.wallet.credited → subscriber) restores it to its exact previous status', () =>
            l2b?.status === 'live' && l2b.suspension === null);
        assert('listing.resumed was emitted and the resume re-indexed unbilled', () =>
            saw('listing.resumed', l2.id) && posts.some((p) => p.path === '' && p.body.listing_id === l2.id)
            && l2b?.vectorisation_job?.billed === false);

        // A debit that crosses the line suspends; a reconcile after a credit resumes.
        await creditWalletService.debit('vendor', v2, (await balanceOf(v2)) - 1, 'whatsapp_template', 'verify-drain');
        const down = await funding.reconcileVendor(v2);
        await flush();
        const l2c = await ListingModel.findById(l2.id).lean();
        assert('⛔ reconcileVendor under the cost suspends every live listing (insufficient_credits)', () =>
            down.suspended.length === 1 && l2c?.status === 'suspended' && l2c.suspension?.reason === 'insufficient_credits');
        assert('listing.suspended { reason: insufficient_credits } was emitted', () =>
            saw('listing.suspended', l2.id, { reason: 'insufficient_credits' }));

        // ─── 7. Administrator suspend / unsuspend ──────────────────────────
        console.log('\n§ 7 admin suspend / unsuspend — funding never lifts an oversight suspension');
        const s1 = await review.suspend(id1, 'Reported: contact painted on the shopfront photo.', ADMIN);
        await flush();
        assert('⛔ suspend: platform_oversight, previous_status live, removed from the index', () =>
            s1.status === 'suspended' && s1.suspension?.reason === 'platform_oversight'
            && posts.some((p) => p.path === '/delete' && p.body.listing_id === id1));
        const r1 = await funding.reconcileVendor(v1); // v1 is well funded
        const stillSuspended = await ListingModel.findById(id1).lean();
        assert('⛔ a well-funded reconcile does NOT lift an administrator\'s suspension', () =>
            r1.resumed.length === 0 && stillSuspended?.suspension?.reason === 'platform_oversight');
        const sweep = await funding.reconcileAllProviderFunding();
        assert('the sweep runs over providers and moves nothing that is already in line', () => sweep.errors === 0);
        const doubleSuspend = await thrownAsync(() => review.suspend(id1, 'again please', ADMIN));
        assert('suspending an oversight-suspended listing is 409', () => codeOf(doubleSuspend) === 'LISTING_STATUS_CONFLICT');
        const u1 = await review.unsuspend(id1, ADMIN);
        await flush();
        // The unsuspension re-index completes, so the listing is in the index again.
        const reindexed = await ListingModel.findById(id1).lean();
        await realVec.applyCallbackResults(reindexed!.vectorisation_job!.jobId, [{ listing_id: id1, status: 'completed', vectorised_id: id1 }]);
        assert('⛔ unsuspend restores the previous status (live) and re-indexes', () =>
            u1.status === 'live' && u1.suspension === null && saw('listing.resumed', id1));
        const notOversight = await thrownAsync(() => review.unsuspend(l2.id, ADMIN));
        assert('⛔ unsuspend refuses a funding suspension (only platform_oversight)', () => codeOf(notOversight) === 'LISTING_STATUS_CONFLICT');

        // ─── 8. Settings ────────────────────────────────────────────────────
        console.log('\n§ 8 listing settings');
        const defaults = await settings.get(v1);
        assert('defaults: continue_engaged, no floor, no cap', () =>
            defaults.onEmpty === 'continue_engaged' && defaults.debtFloor === null && defaults.maxCreditsPerCustomerPerDay === null);
        await settings.put(v1, { onEmpty: 'stop', debtFloor: -30, maxCreditsPerCustomerPerDay: 15 });
        const stored = await VendorModel.findById(v1, { listing_settings: 1 }).lean();
        assert('PUT writes vendors.listing_settings in snake case', () =>
            (stored as any)?.listing_settings?.on_empty === 'stop' && (stored as any).listing_settings.debt_floor === -30
            && (stored as any).listing_settings.max_credits_per_customer_per_day === 15);
        const bad = await thrownAsync(() => settings.put(v1, { onEmpty: 'stop', debtFloor: 5, maxCreditsPerCustomerPerDay: null }));
        assert('⛔ a positive floor is 422 LISTING_SETTINGS_INVALID', () => codeOf(bad) === 'LISTING_SETTINGS_INVALID');

        // ─── 9. Quota and archive ───────────────────────────────────────────
        console.log('\n§ 9 the plan slot and archive');
        slotLimit.value = 1; // v1 holds one live listing already
        const extra = await prov.create(v1, { content: fullContent('Painter Akwa'), contacts: { phone: '+237655444555' } });
        const q0 = await balanceOf(v1);
        const full = await thrownAsync(() => provider.submit(v1, extra.id));
        const q1 = await balanceOf(v1);
        assert('⛔ a first submission past max_active_listings is BILLING_LIMIT_EXCEEDED, nothing charged', () =>
            codeOf(full) === 'BILLING_LIMIT_EXCEEDED' && q1 === q0);
        slotLimit.value = 3;

        const archived = await provider.archive(v1, id1);
        await flush();
        assert('⛔ archive: archived, out of the index, capacity_freed published', () =>
            archived.status === 'archived' && saw('quota.capacity_freed', v1)
            && (posts.filter((p) => p.path === '/delete' && p.body.listing_id === id1).length >= 2));
        const gone = await thrownAsync(() => publicReads.bySlug(l1b!.slug));
        assert('an archived listing 404s publicly (LISTING_NOT_FOUND)', () => codeOf(gone) === 'LISTING_NOT_FOUND');
        const reArchive = await thrownAsync(() => provider.archive(v1, id1));
        assert('archiving twice is 409', () => codeOf(reArchive) === 'LISTING_STATUS_CONFLICT');
        const foreign = await thrownAsync(() => provider.get(v2, extra.id));
        assert('⛔ another vendor\'s listing is 404 (scoped at the query)', () => codeOf(foreign) === 'LISTING_NOT_FOUND');

        const all = await publicReads.list({ page: 1, limit: 50 });
        assert('⛔ end state: no contact value anywhere on the public list', () => leaks(all).length === 0);
    } finally {
        await flush();
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error(err);
    try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch { /* already gone */ }
    process.exit(1);
});
