/**
 * test:service-listings-catalog — informational service listings, walk-order step 3 and the
 * jovi-mall halves of steps 4 and 5 (DB-free).
 *
 * Plan: PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md (L-5, L-6, L-17, L-18, L-26, O-15, O-18,
 * § C-2 … § C-8a).
 *
 *   § 1  completeness — what SUBMIT requires (`LISTING_INCOMPLETE`, each missing field)
 *   § 2  contact validators — E.164, email, http(s) links, the video host (lookalikes refused)
 *   § 3  the revision state machine (L-5)
 *   § 4  slugs
 *   § 5  text pre-flags (O-15)
 *   § 6  ⛔ the public DTOs carry no contact, no vendorId, no pin — and exactly the § C-3 keys
 *   § 7  ⛔ the listing vectoriser payload carries no contact, no vendor block, no coordinates
 *   § 8  ⛔ the product vectoriser path is unchanged when `kind` is absent
 *   § 9  ⛔ every listings router declares its kind (or is public / internal)
 *   § 10 ⛔ `listing_contacts` is reached only through its repository
 *   § 11 ⛔ approve writes `available_fields` from NAMES only
 *   § 12 listing settings (L-10, L-11, L-30)
 *   § 13 the YouTube oEmbed verdicts (no network)
 *   § 14 submit / withdraw on stubs — fee, quota, oEmbed, pre-flags, CAS refund
 *
 * Every ⛔ guard here was mutation-proven when written: break the guarded line, watch the
 * named assertion fail, restore it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../../src/core/error-codes';
import { LISTING_CONTACT_FIELDS, LISTING_REQUIRED_FIELDS } from '../../src/modules/listings/domain/listing.types';
import {
    availableFieldsOf,
    canPerform,
    classifyVideoUrl,
    detectPreflags,
    editOpensRevision,
    findMissing,
    isHttpUrl,
    listingSlugBase,
    occupiesSlot,
    settingsProblem,
    slugCandidate,
    statusAfter,
    ListingStateView,
} from '../../src/modules/listings/domain/listing-rules';
import { ListingContactsInputSchema, ListingWriteSchema, ListingSettingsSchema } from '../../src/modules/listings/validators/listing.validator';
import { applyContactsPatch } from '../../src/modules/listings/domain/services/listing-content.mapper';
import { toPublicListingCard, toPublicListingDetail } from '../../src/modules/listings/dto/public-listing.dto';
import { buildListingVectoriserPayload } from '../../src/modules/listings/domain/listing-vectoriser.payload';
import {
    splitCallbackByKind,
    isListingPayloadsRequest,
    VectoriserCallbackSchema,
} from '../../src/modules/catalog/validators/internal-vectoriser.validator';
import { YoutubeOembedChecker, oembedUrlFor } from '../../src/modules/listings/domain/services/youtube-oembed.checker';
import { ListingProviderService } from '../../src/modules/listings/domain/services/listing-provider.service';
import { categoryCatalogCache } from '../../src/modules/categories/services/category-catalog.cache';

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
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Drop comments so a header that QUOTES a guard cannot satisfy the scan. A character walk, not
 * a regex — see `test-service-listings.ts` for the defect the regex version caused.
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
const code = (rel: string): string => stripComments(read(rel));

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walkTs(full));
        else if (entry.endsWith('.ts')) out.push(full);
    }
    return out.sort();
}
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

const codeOf = (err: unknown): string | undefined => (err as { code?: string } | undefined)?.code;
const statusOf = (err: unknown): number | undefined => (err as { statusCode?: number } | undefined)?.statusCode;
function thrown(fn: () => unknown): unknown {
    try { fn(); } catch (err) { return err; }
    return undefined;
}
async function thrownAsync(fn: () => Promise<unknown>): Promise<unknown> {
    try { await fn(); } catch (err) { return err; }
    return undefined;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COMPLETE = {
    title: 'Plumbing repairs',
    company_name: 'Jean Plomberie',
    category_ids: [new Types.ObjectId()],
    country: 'CM',
    city: 'Douala',
    area: 'Akwa',
    description: 'Leaks, pipes, water heaters — fast and clean.',
};
const ONE_CONTACT = { whatsapp: '+237670000001' };

/** Contact values that must never surface on a public / index path. */
const POISON = {
    whatsapp: '+237699111222',
    phone: '+237699333444',
    email: 'secret.owner@poison.example',
    website: 'https://poison-site.example',
    social: 'https://facebook.com/poison.page',
    video: 'https://youtu.be/POISONVIDEO1',
    address: '12 Rue Secrete, Akwa',
    lng: 9.7654321,
    lat: 4.0512345,
    vendorEmail: 'vendor.owner@poison.example',
    vendorPhone: '+237699555666',
};

function poisonedRow(): Record<string, unknown> {
    const contacts = {
        whatsapp: POISON.whatsapp, phone: POISON.phone, email: POISON.email, website: POISON.website,
        socials: [{ network: 'facebook', url: POISON.social }],
        location: { formatted_address: POISON.address, coordinates: { type: 'Point', coordinates: [POISON.lng, POISON.lat] } },
        video: { url: POISON.video, host: 'youtube', checked_at: null },
    };
    return {
        _id: new Types.ObjectId(),
        vendor_id: new Types.ObjectId(),
        slug: 'jean-plomberie',
        status: 'live',
        published_at: new Date('2026-10-01T00:00:00Z'),
        available_fields: ['whatsapp', 'location', 'not-a-field', POISON.phone],
        published: {
            ...COMPLETE,
            description_rich: null,
            photo_file_ids: [],
            opening_hours: [{ day: 'monday', open_time: '08:00', close_time: '17:00', is_closed: false }],
            // A future schema slip: contact-shaped keys smuggled into the PUBLIC content.
            ...contacts,
        },
        pending: { ...contacts, title: 'pending title' },
        contacts: { published: contacts, pending: contacts },
        vendor: { email: POISON.vendorEmail, phone: POISON.vendorPhone, kind: 'provider' },
        review: { preflags: [{ kind: 'phone', field: 'description', excerpt: POISON.phone }] },
        suspension: null,
        vectorised_data_id: 'vec-1',
        vectorisation_job: null,
    };
}
const POISON_STRINGS = [
    POISON.whatsapp, POISON.phone, POISON.email, POISON.website, POISON.social, POISON.video, POISON.address,
    String(POISON.lng), String(POISON.lat), POISON.vendorEmail, POISON.vendorPhone, 'POISONVIDEO1',
    '699111222', '699333444', 'poison',
];
const leaks = (value: unknown): string[] => {
    const json = JSON.stringify(value);
    return POISON_STRINGS.filter((s) => json.includes(s));
};

const view = (over: Partial<ListingStateView>): ListingStateView => ({
    status: 'draft', hasPublished: false, hasPending: true, reviewState: 'editing', ...over,
});

async function main(): Promise<void> {
    // ─── § 1 Completeness ───────────────────────────────────────────────────
    console.log('\n§ 1 completeness — what SUBMIT requires');

    assert('a complete listing with one contact field is missing nothing', () =>
        findMissing(COMPLETE, ONE_CONTACT).length === 0);
    assert('`details.missing[]` names are the § C-4 wire names, eight of them', () =>
        JSON.stringify([...LISTING_REQUIRED_FIELDS]) === JSON.stringify(
            ['title', 'companyName', 'categories', 'country', 'city', 'area', 'description', 'contact']));
    const missingWhen = (over: Record<string, unknown>, contacts: Record<string, unknown> = ONE_CONTACT) =>
        findMissing({ ...COMPLETE, ...over } as never, contacts as never);
    const only = (got: string[], want: string) => got.length === 1 && got[0] === want;
    assert('⛔ title under 3 characters → missing `title`', () => only(missingWhen({ title: 'ab' }), 'title'));
    assert('title over 120 characters → missing `title`', () => only(missingWhen({ title: 'x'.repeat(121) }), 'title'));
    assert('a whitespace title counts as missing', () => only(missingWhen({ title: '     ' }), 'title'));
    assert('⛔ company name under 2 → missing `companyName`', () => only(missingWhen({ company_name: 'J' }), 'companyName'));
    assert('⛔ no category → missing `categories`', () => only(missingWhen({ category_ids: [] }), 'categories'));
    assert('six categories → missing `categories` (1–5)', () =>
        only(missingWhen({ category_ids: [1, 2, 3, 4, 5, 6] }), 'categories'));
    assert('⛔ country must be ISO-2 → missing `country`', () =>
        only(missingWhen({ country: 'CMR' }), 'country') && only(missingWhen({ country: '' }), 'country'));
    assert('⛔ no city → missing `city`', () => only(missingWhen({ city: '' }), 'city'));
    assert('⛔ no area → missing `area`', () => only(missingWhen({ area: ' ' }), 'area'));
    assert('⛔ description under 20 characters → missing `description`', () =>
        only(missingWhen({ description: 'Short text here.' }), 'description'));
    assert('⛔ no contact field at all → missing `contact`', () => only(missingWhen({}, {}), 'contact'));
    assert('an empty socials list and a null video are not a contact', () =>
        only(missingWhen({}, { socials: [], video: null, location: null }), 'contact'));
    assert('any ONE contact field satisfies `contact` (location alone counts)', () =>
        findMissing(COMPLETE, { location: { formatted_address: 'x' } }).length === 0);
    assert('a null working copy is missing everything', () => findMissing(null, null).length === 8);

    // ─── § 2 Contact validators ─────────────────────────────────────────────
    console.log('\n§ 2 contact validators');

    const contactsOk = (c: Record<string, unknown>) => ListingContactsInputSchema.safeParse(c).success;
    assert('WhatsApp / phone: E.164 accepted, spacing normalised', () => {
        const r = ListingContactsInputSchema.safeParse({ whatsapp: '+237 670 00 00 01', phone: '+33612345678' });
        return r.success && r.data.whatsapp === '+237670000001';
    });
    assert('⛔ a local number with no country code is a 400', () => !contactsOk({ whatsapp: '670000001' }));
    assert('⛔ an incomplete +237 is a 400', () => !contactsOk({ phone: '+237' }));
    assert('an empty string clears a phone (null)', () => {
        const r = ListingContactsInputSchema.safeParse({ phone: '' });
        return r.success && r.data.phone === null;
    });
    assert('email: valid accepted and lowercased; malformed refused', () => {
        const r = ListingContactsInputSchema.safeParse({ email: 'Jean@Example.COM' });
        return r.success && r.data.email === 'jean@example.com' && !contactsOk({ email: 'jean@' });
    });
    assert('⛔ website: http(s) only — javascript:, ftp: and a bare word refused', () =>
        contactsOk({ website: 'https://jean.example' }) && contactsOk({ website: 'http://jean.example/a' })
        && !contactsOk({ website: 'javascript:alert(1)' }) && !contactsOk({ website: 'ftp://jean.example' })
        && !contactsOk({ website: 'jean' }));
    assert('socials: http(s), at most 5, known networks only', () =>
        contactsOk({ socials: [{ network: 'facebook', url: 'https://facebook.com/x' }] })
        && !contactsOk({ socials: [{ network: 'facebook', url: 'facebook.com/x' }] })
        && !contactsOk({ socials: Array(6).fill({ network: 'x', url: 'https://x.com/a' }) })
        && !contactsOk({ socials: [{ network: 'myspace', url: 'https://myspace.com/a' }] }));
    assert('location is a GeoAddress (shared schema) or null', () =>
        contactsOk({ location: { formatted_address: 'Akwa, Douala', coordinates: { type: 'Point', coordinates: [9.7, 4.05] }, provider: 'nominatim' } })
        && contactsOk({ location: null }) && !contactsOk({ location: { formatted_address: 'x' } }));
    assert('isHttpUrl refuses a dotless host and a non-http scheme', () =>
        isHttpUrl('https://a.example') && !isHttpUrl('https://localhost') && !isHttpUrl('mailto:a@b.example'));

    assert('video: YouTube watch, youtu.be, shorts and embed links are youtube', () =>
        classifyVideoUrl('https://www.youtube.com/watch?v=abc123') === 'youtube'
        && classifyVideoUrl('https://youtu.be/abc123') === 'youtube'
        && classifyVideoUrl('https://m.youtube.com/shorts/abc123') === 'youtube'
        && classifyVideoUrl('https://youtube.com/embed/abc123') === 'youtube');
    assert('video: a Drive file link is google_drive', () =>
        classifyVideoUrl('https://drive.google.com/file/d/1AbC/view?usp=sharing') === 'google_drive'
        && classifyVideoUrl('https://drive.google.com/open?id=1AbC') === 'google_drive');
    assert('⛔ video: lookalike hosts are refused (youtube.com.evil.example, notyoutube.com, youtu.be.evil)', () =>
        classifyVideoUrl('https://youtube.com.evil.example/watch?v=abc') === null
        && classifyVideoUrl('https://notyoutube.com/watch?v=abc') === null
        && classifyVideoUrl('https://youtu.be.evil.example/abc') === null
        && classifyVideoUrl('https://drive.google.com.evil.example/file/d/1') === null);
    assert('video: other hosts, a YouTube channel page and a Drive folder are refused', () =>
        classifyVideoUrl('https://vimeo.com/123') === null
        && classifyVideoUrl('https://www.youtube.com/@jeanplomberie') === null
        && classifyVideoUrl('https://www.youtube.com/watch') === null
        && classifyVideoUrl('https://drive.google.com/drive/folders/1AbC') === null
        && classifyVideoUrl('javascript:alert(1)//youtube.com/watch?v=1') === null);
    assert('⛔ applyContactsPatch: a non-YouTube/Drive video is 422 LISTING_VIDEO_LINK_INVALID', () => {
        const err = thrown(() => applyContactsPatch(null, { video: { url: 'https://youtube.com.evil.example/watch?v=a' } }));
        return codeOf(err) === ERROR_CODES.LISTING_VIDEO_LINK_INVALID && statusOf(err) === 422;
    });
    assert('applyContactsPatch: a valid video gets its host and starts unchecked', () => {
        const set = applyContactsPatch(null, { video: { url: 'https://youtu.be/abc' } });
        return set.video?.host === 'youtube' && set.video.checked_at === null;
    });
    assert('applyContactsPatch: an unchanged video link keeps its checked_at', () => {
        const at = new Date('2026-10-10T00:00:00Z');
        const base = { ...applyContactsPatch(null, {}), video: { url: 'https://youtu.be/abc', host: 'youtube' as const, checked_at: at } };
        return applyContactsPatch(base, { video: { url: 'https://youtu.be/abc' } }).video?.checked_at === at;
    });
    assert('the video is NOT host-checked by Zod (a wrong host must reach the service as a 422)', () =>
        ListingContactsInputSchema.safeParse({ video: { url: 'https://vimeo.com/1' } }).success);
    assert('a write body refuses unknown top-level keys (no `status`, no `vendorId`)', () =>
        !ListingWriteSchema.safeParse({ status: 'live' }).success
        && !ListingWriteSchema.safeParse({ content: { vendorId: 'x' } }).success);

    // ─── § 3 State machine ──────────────────────────────────────────────────
    console.log('\n§ 3 the revision state machine (L-5)');

    const live = view({ status: 'live', hasPublished: true, hasPending: false, reviewState: null });
    assert('a draft can be edited and submitted', () =>
        canPerform('edit', view({})) && canPerform('submit', view({})));
    assert('⛔ nothing can be edited while waiting for review (409)', () =>
        !canPerform('edit', view({ reviewState: 'pending_review', status: 'pending_review' }))
        && !canPerform('edit', view({ status: 'live', hasPublished: true, reviewState: 'pending_review' })));
    assert('⛔ the first edit of a LIVE listing opens a revision', () =>
        canPerform('edit', live) && editOpensRevision(live));
    assert('editing a draft does not "open a revision"', () => !editOpensRevision(view({})));
    assert('a live listing with no working copy has nothing to submit', () => !canPerform('submit', live));
    assert('a rejected working copy can be resubmitted', () =>
        canPerform('submit', view({ status: 'rejected', reviewState: 'rejected' })));
    assert('withdraw only while pending_review', () =>
        canPerform('withdraw', view({ reviewState: 'pending_review' })) && !canPerform('withdraw', view({})));
    assert('discard a revision only on a published listing carrying one', () =>
        canPerform('discard_revision', view({ status: 'live', hasPublished: true, hasPending: true }))
        && !canPerform('discard_revision', view({})) && !canPerform('discard_revision', live));
    assert('⛔ an archived listing accepts no action at all', () =>
        (['edit', 'submit', 'withdraw', 'discard_revision', 'archive'] as const)
            .every((a) => !canPerform(a, view({ status: 'archived', reviewState: 'pending_review', hasPublished: true }))));
    assert('archive from any non-archived status (suspended included)', () =>
        canPerform('archive', view({ status: 'suspended', hasPublished: true })));
    assert('⛔ a never-published listing walks draft → pending_review → rejected / draft', () =>
        statusAfter('submit', view({})) === 'pending_review'
        && statusAfter('withdraw', view({ status: 'pending_review' })) === 'draft'
        && statusAfter('reject', view({ status: 'pending_review' })) === 'rejected');
    assert('⛔ a LIVE listing stays live through submit, withdraw and reject of its revision', () => {
        const v = view({ status: 'live', hasPublished: true });
        return statusAfter('submit', v) === 'live' && statusAfter('withdraw', v) === 'live' && statusAfter('reject', v) === 'live';
    });
    assert('a suspended listing keeps its suspension through a revision', () =>
        statusAfter('submit', view({ status: 'suspended', hasPublished: true })) === 'suspended');
    assert('slot rule (§ C-8a): live, pending_review and non-quota suspensions occupy; quota-suspended frees', () =>
        occupiesSlot('live', null) && occupiesSlot('pending_review', null)
        && occupiesSlot('suspended', 'insufficient_credits') && occupiesSlot('suspended', 'platform_oversight')
        && !occupiesSlot('suspended', 'plan_quota_exceeded') && !occupiesSlot('draft', null)
        && !occupiesSlot('rejected', null) && !occupiesSlot('archived', null));

    // ─── § 4 Slugs ──────────────────────────────────────────────────────────
    console.log('\n§ 4 slugs');

    assert('ascii, lowercase, hyphenated', () => listingSlugBase('Jean Plomberie & Fils') === 'jean-plomberie-fils');
    assert('accents are folded, not dropped', () => listingSlugBase('Plomberie Yaoundé — Bépanda') === 'plomberie-yaounde-bepanda');
    assert('an empty or symbol-only title falls back to `listing`', () =>
        listingSlugBase('') === 'listing' && listingSlugBase('!!!') === 'listing' && listingSlugBase(null) === 'listing');
    assert('long titles are capped and never end on a hyphen', () => {
        const s = listingSlugBase(`${'a'.repeat(79)} b`);
        return s.length <= 80 && !s.endsWith('-');
    });
    assert('collision suffixes: base, base-2, base-3', () =>
        slugCandidate('x', 1) === 'x' && slugCandidate('x', 2) === 'x-2' && slugCandidate('x', 3) === 'x-3');
    assert('the slug matches the public slug param pattern', () =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(listingSlugBase('  Électricité  générale  24/7 ')));

    // ─── § 5 Pre-flags ──────────────────────────────────────────────────────
    console.log('\n§ 5 text pre-flags (O-15)');

    const flags = detectPreflags({
        title: 'Plombier — appelez le 6 77 12 34 56',
        company_name: 'Jean SARL',
        area: 'Akwa',
        description: 'Écrivez à jean.plombier@gmail.com ou wa.me/237677123456, voir www.jean.example et jean-plomberie.com. Ouvert 7j/7, depuis 2009.',
    });
    const has = (kind: string, field: string, needle: string) =>
        flags.some((f) => f.kind === kind && f.field === field && f.excerpt.includes(needle));
    assert('⛔ a spaced local phone number in the title is flagged', () => has('phone', 'title', '6 77 12 34 56'));
    assert('⛔ an email in the description is flagged', () => has('email', 'description', 'jean.plombier@gmail.com'));
    assert('⛔ wa.me, www. and a bare domain are flagged as links', () =>
        has('url', 'description', 'wa.me/') && has('url', 'description', 'www.jean.example') && has('url', 'description', 'jean-plomberie.com'));
    assert('the email\'s domain is not reported a second time as a link', () =>
        !flags.some((f) => f.kind === 'url' && f.excerpt.includes('gmail.com')));
    assert('short numbers (a year, "7j/7") are not phone numbers', () =>
        !flags.some((f) => f.kind === 'phone' && (f.excerpt.includes('2009') || f.excerpt.includes('7j'))));
    assert('clean text raises nothing', () => detectPreflags({ title: 'Plumbing repairs', area: 'Akwa' }).length === 0);
    assert('excerpts are capped at 200 characters', () =>
        detectPreflags({ description: `https://x.example/${'a'.repeat(400)}` }).every((f) => f.excerpt.length <= 200));

    // ─── § 6 Public DTOs ────────────────────────────────────────────────────
    console.log('\n§ 6 ⛔ the public DTOs carry no contact, no vendorId, no pin');

    const row = poisonedRow();
    const ctx = {
        categories: [{ id: 'c1', name: 'Plumbing', slug: 'plumbing' }],
        photos: [],
        revealCosts: { first: 7, next: 4 },
        rating: null,
    };
    const card = toPublicListingCard(row as never, ctx);
    const detail = toPublicListingDetail(row as never, ctx);
    const CARD_KEYS = ['id', 'slug', 'kind', 'title', 'companyName', 'categories', 'country', 'city', 'area', 'photo', 'rating', 'availableFields', 'revealCosts'];
    const DETAIL_KEYS = [...CARD_KEYS, 'description', 'descriptionRich', 'photos', 'openingHours', 'publishedAt'];
    if (leaks(card).length) console.error(`      card leaks: ${leaks(card).join(', ')}`);
    if (leaks(detail).length) console.error(`      detail leaks: ${leaks(detail).join(', ')}`);
    assert('⛔ the card built from a poisoned row contains no contact value', () => leaks(card).length === 0);
    assert('⛔ the detail built from a poisoned row contains no contact value', () => leaks(detail).length === 0);
    assert('⛔ the card has exactly the § C-3 key set', () =>
        JSON.stringify(Object.keys(card).sort()) === JSON.stringify([...CARD_KEYS].sort()));
    assert('⛔ the detail has exactly the § C-3 key set', () =>
        JSON.stringify(Object.keys(detail).sort()) === JSON.stringify([...DETAIL_KEYS].sort()));
    assert('⛔ no vendorId, no vendor block, no coordinates on either', () => {
        const json = JSON.stringify([card, detail]);
        return !/vendor/i.test(json) && !/coordinates|latitude|longitude/.test(json);
    });
    assert('kind is `listing`, and availableFields are known NAMES only, in button order', () =>
        card.kind === 'listing' && JSON.stringify(card.availableFields) === JSON.stringify(['whatsapp', 'location']));
    assert('revealCosts and the rating seam (null) are on the card', () =>
        card.revealCosts.first === 7 && card.revealCosts.next === 4 && card.rating === null);
    assert('opening hours go out in wire case', () =>
        JSON.stringify(detail.openingHours) === JSON.stringify([{ day: 'monday', openTime: '08:00', closeTime: '17:00', isClosed: false }]));
    const dtoSrc = code('src/modules/listings/dto/public-listing.dto.ts');
    assert('⛔ the public DTO file spreads no document (the only spread is the card into the detail)', () =>
        (dtoSrc.match(/\.\.\./g) ?? []).length === 2 && dtoSrc.includes('...toPublicListingCard(row, ctx)')
        && dtoSrc.includes('[...ctx.photos]'));

    // ─── § 7 Vectoriser payload ─────────────────────────────────────────────
    console.log('\n§ 7 ⛔ the listing vectoriser payload');

    const payload = buildListingVectoriserPayload(row as never, { categoryNames: ['Plumbing', 'Repairs'], images: [] })!;
    if (leaks(payload).length) console.error(`      payload leaks: ${leaks(payload).join(', ')}`);
    assert('⛔ the payload built from a poisoned row contains no contact value', () => leaks(payload).length === 0);
    assert('⛔ kind is `listing` and the id travels as listing_id, never product_id', () =>
        payload.kind === 'listing' && payload.listing_id === String(row._id) && !('product_id' in payload));
    assert('⛔ no vendor block, no email, no coordinates', () => {
        const json = JSON.stringify(payload);
        return !('vendor' in payload) && !/email|coordinates|latitude|longitude|whatsapp|phone/.test(json);
    });
    assert('the payload has exactly the documented keys', () =>
        JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(
            ['area', 'categories', 'category', 'city', 'company_name', 'country', 'description', 'images', 'kind',
                'listing_id', 'opening_hours', 'slug', 'status', 'title'].sort()));
    assert('category is the primary, categories the full list', () =>
        payload.category === 'Plumbing' && JSON.stringify(payload.categories) === JSON.stringify(['Plumbing', 'Repairs']));
    assert('a row with nothing published builds no payload', () =>
        buildListingVectoriserPayload({ _id: 'x', slug: 's', published: null }, { categoryNames: [], images: [] }) === null);
    const payloadSrc = code('src/modules/listings/domain/listing-vectoriser.payload.ts');
    assert('⛔ the payload builder spreads nothing from the row', () =>
        !/\.\.\.row|\.\.\.p\b|\.\.\.row\.published/.test(payloadSrc));

    // ─── § 8 Product vectoriser path unchanged ──────────────────────────────
    console.log('\n§ 8 ⛔ the product vectoriser path is unchanged when `kind` is absent');

    const productReport = {
        job_id: '833', finished_at: '2026-09-06T05:38:20.938Z', total: 1, succeeded: 1, failed: 0,
        results: [{ product_id: '000000000000000000000001', status: 'completed', vectorised_id: '000000000000000000000001', error: null }],
    };
    assert('⛔ a product-only report is passed through as the SAME object', () => {
        const split = splitCallbackByKind(productReport);
        return split.productBody === productReport && split.listingRows.length === 0;
    });
    assert('a row with `kind: "product"` stays on the product path', () => {
        const body = { job_id: '1', results: [{ kind: 'product', product_id: 'a', status: 'completed' }] };
        return splitCallbackByKind(body).productBody === body;
    });
    assert('a mixed report splits: listing rows out, product rows kept in order', () => {
        const body = { job_id: '2', results: [
            { product_id: 'p1', status: 'completed' },
            { kind: 'listing', listing_id: 'l1', status: 'failed' },
            { product_id: 'p2', status: 'failed' },
        ] };
        const split = splitCallbackByKind(body);
        const kept = (split.productBody as { results: Array<{ product_id: string }> }).results.map((r) => r.product_id);
        return split.listingRows.length === 1 && JSON.stringify(kept) === JSON.stringify(['p1', 'p2']);
    });
    assert('a malformed body is passed through for the product schema to refuse, as before', () => {
        const body = { job_id: '3' };
        return splitCallbackByKind(body).productBody === body && !VectoriserCallbackSchema.safeParse(body).success;
    });
    assert('the product report still parses to the same shape', () => {
        const parsed = VectoriserCallbackSchema.parse(productReport);
        return parsed.job_id === '833' && parsed.results[0].product_id === '000000000000000000000001';
    });
    assert('a /payloads body with no kind is a product request', () =>
        !isListingPayloadsRequest({ product_ids: ['000000000000000000000001'] })
        && isListingPayloadsRequest({ kind: 'listing', listing_ids: [] }) && !isListingPayloadsRequest(null));

    const ctrl = code('src/modules/catalog/controllers/internal-vectoriser.controller.ts');
    assert('⛔ callback: split first, then the UNCHANGED product schema + applyCallbackReport', () =>
        /const \{ productBody, listingRows \} = splitCallbackByKind\(req\.body\);\s*const report = VectoriserCallbackSchema\.parse\(productBody\);\s*const result = await vectorisationService\.applyCallbackReport\(report\);/.test(ctrl));
    assert('⛔ callback: a report with no listing row answers exactly `{ success, data: result }`', () =>
        /if \(listingRows\.length === 0\) \{\s*res\.json\(\{ success: true, data: result \}\);\s*return;\s*\}/.test(ctrl));
    assert('⛔ payloads: the listing branch is gated on isListingPayloadsRequest and returns before the product parse', () => {
        const i = ctrl.indexOf('if (isListingPayloadsRequest(req.body))');
        const j = ctrl.indexOf('const { product_ids } = VectoriserPayloadsSchema.parse(req.body);');
        return i > 0 && j > i && ctrl.slice(i, j).includes('return;');
    });
    const validatorSrc = code('src/modules/catalog/validators/internal-vectoriser.validator.ts');
    assert('the product callback row schema still requires product_id (untouched)', () =>
        /const VectoriserCallbackResultSchema = z\.object\(\{\s*product_id: z\.string\(\)\.min\(1\),/.test(validatorSrc)
        && /results: z\.array\(VectoriserCallbackResultSchema\),/.test(validatorSrc));

    // ─── § 9 Routers ────────────────────────────────────────────────────────
    console.log('\n§ 9 ⛔ every listings router declares its kind (or is public / internal)');

    const routeFiles = walkTs(path.join(ROOT, 'src/modules/listings/routes')).map(rel);
    // Six since 2026-11-07: the customer router (reveal + consents) and the provider's leads.
    assert('six listings routers exist', () => routeFiles.length === 6);
    for (const file of routeFiles) {
        const src = code(file);
        if (/requireRole\(\['customer'\]\)/.test(src)) {
            // The customer side: BOTH routers in the file are customer-session only, and neither
            // admits a vendor — a vendor session on the same account unlocks nothing.
            assert(`⛔ ${file}: every router is requireAuth + requireRole(['customer']), and no vendor kind`, () =>
                (src.match(/\.use\(requireAuth\)/g) ?? []).length === 2
                && (src.match(/\.use\(requireRole\(\['customer'\]\)\)/g) ?? []).length === 2
                && !/'vendor'/.test(src) && !/requireVendorKind/.test(src));
        } else if (/requireRole\(/.test(src)) {
            assert(`⛔ ${file}: requireAuth + requireRole(['vendor']) + router-level requireVendorKind('provider')`, () =>
                /router\.use\(requireAuth\)/.test(src) && /router\.use\(requireRole\(\['vendor'\]\)\)/.test(src)
                && /router\.use\(requireVendorKind\('provider'\)\)/.test(src));
        } else if (/export function buildAdminListingRouter\(guards: RequestHandler\[\]\)/.test(src)) {
            assert(`${file}: the admin factory applies its guard chain before any route`, () =>
                /router\.use\(\.\.\.guards\);\s*return attachRoutes\(router\);/.test(src));
        } else {
            assert(`⛔ ${file}: a public router — GETs only, no auth, no write`, () =>
                !/requireAuth/.test(src) && !/router\.(post|put|patch|delete)\(/.test(src) && /router\.get\(/.test(src));
        }
    }
    const indexSrc = code('src/api/index.ts');
    assert('⛔ the provider routers are mounted at their OWN prefixes (never bare /vendor)', () =>
        indexSrc.includes("router.use('/vendor/listings', vendorListingRoutes);")
        && indexSrc.includes("router.use('/vendor/listing-settings', vendorListingSettingsRoutes);"));
    assert('the public router is mounted after the /public rate limiter', () => {
        const limiter = indexSrc.indexOf("router.use('/public', publicRateLimiter);");
        const mine = indexSrc.indexOf("router.use('/public', publicListingRoutes);");
        return limiter > 0 && mine > limiter;
    });
    assert('the admin factory is mounted behind requireAdminCaller', () =>
        code('src/api/routes/internal-admin.routes.ts').includes("router.use('/listings', buildAdminListingRouter([requireAdminCaller]));"));
    const publicRoutes = code('src/modules/listings/routes/public-listing.routes.ts');
    assert('`/listings/by-ids` is declared before `/listings/:slug`', () =>
        publicRoutes.indexOf("'/listings/by-ids'") > 0 && publicRoutes.indexOf("'/listings/by-ids'") < publicRoutes.indexOf("'/listings/:slug'"));

    // ─── § 10 listing_contacts ──────────────────────────────────────────────
    console.log('\n§ 10 ⛔ listing_contacts is reached only through its repository');

    const listingFiles = walkTs(path.join(ROOT, 'src/modules/listings')).map(rel);
    const MODEL = /listing-contact\.model'|ListingContactModel\b|COLLECTIONS\.LISTING_CONTACT\b|'listing_contacts'/;
    const modelReaders = listingFiles.filter((f) => MODEL.test(code(f)));
    if (modelReaders.length !== 2) console.error(`      model named in: ${modelReaders.join(', ')}`);
    assert('⛔ inside the module, only the model file and listing-contact.repository.ts name the model', () =>
        JSON.stringify(modelReaders) === JSON.stringify([
            'src/modules/listings/models/listing-contact.model.ts',
            'src/modules/listings/repositories/listing-contact.repository.ts',
        ]));
    const REPO = /listing-contact\.repository'/;
    const repoUsers = listingFiles.filter((f) => REPO.test(code(f))).sort();
    const ALLOWED_REPO_USERS = [
        'src/modules/listings/domain/services/listing-content.mapper.ts',   // types only
        'src/modules/listings/domain/services/listing-provider.service.ts', // the provider's own data
        'src/modules/listings/domain/services/listing-review.service.ts',   // approve: pending → published
        'src/modules/listings/domain/services/listing-reveal.service.ts',   // the reveal: ONE published field
        'src/modules/listings/domain/services/listing-lead.service.ts',     // call-me: the provider's OWN numbers (not a reveal)
        'src/modules/listings/dto/vendor-listing.dto.ts',                   // types only: the provider's own detail
        'src/modules/listings/index.ts',                                    // re-export for the closure eraser
    ];
    if (repoUsers.some((f) => !ALLOWED_REPO_USERS.includes(f))) console.error(`      repository used by: ${repoUsers.join(', ')}`);
    assert('⛔ the contact repository is used only by the provider, review and type-only paths', () =>
        repoUsers.every((f) => ALLOWED_REPO_USERS.includes(f)));
    for (const f of [
        'src/modules/listings/domain/services/public-listing.service.ts',
        'src/modules/listings/domain/services/listing-vectorisation.service.ts',
        'src/modules/listings/domain/listing-vectoriser.payload.ts',
        'src/modules/listings/dto/public-listing.dto.ts',
        'src/modules/listings/repositories/listing.repository.ts',
        'src/modules/listings/domain/public-listing.filter.ts',
    ]) {
        assert(`⛔ ${f} cannot reach a contact (imports neither the model nor its repository)`, () => {
            const src = code(f);
            return !MODEL.test(src) && !REPO.test(src);
        });
    }
    const contactRepoSrc = code('src/modules/listings/repositories/listing-contact.repository.ts');
    const methods = [...contactRepoSrc.matchAll(/^\s{2}async (\w+)\(/gm)].map((m) => m[1]).sort();
    assert('the contact repository exposes exactly its five documented methods', () =>
        JSON.stringify(methods) === JSON.stringify(['eraseForVendor', 'getForOwner', 'publishPending', 'readPublishedField', 'upsertPending']));
    assert('readPublishedField projects ONE field of the PUBLISHED set (never pending, never the set)', () =>
        /\{ \[`published\.\$\{field\}`\]: 1 \}/.test(contactRepoSrc));
    assert('getForOwner is scoped by BOTH the listing and the vendor', () =>
        /listing_id: new Types\.ObjectId\(listingId\), vendor_id: new Types\.ObjectId\(vendorId\)/.test(contactRepoSrc));

    // ─── § 11 Approve: names only ───────────────────────────────────────────
    console.log('\n§ 11 ⛔ approve writes available_fields from NAMES only');

    const reviewSrc = code('src/modules/listings/domain/services/listing-review.service.ts');
    assert('⛔ approve derives available_fields with availableFieldsOf(published) and writes only that', () =>
        /const available = availableFieldsOf\(published\);/.test(reviewSrc)
        && /available_fields: available,/.test(reviewSrc)
        && (reviewSrc.match(/available_fields:/g) ?? []).length === 1);
    assert('⛔ approve publishes contacts inside its transaction (publishPending(listingId, session))', () =>
        /runInTransactionWithRetry\(async \(session\) => \{\s*const published = await this\.contacts\.publishPending\(listingId, session\);/.test(reviewSrc));
    assert('approve is a CAS on review.state pending_review', () =>
        /\{ _id: row\._id, status: row\.status, 'review\.state': 'pending_review' \}/.test(reviewSrc));
    const names = availableFieldsOf({
        whatsapp: POISON.whatsapp, phone: POISON.phone, email: POISON.email, website: POISON.website,
        socials: [{ url: POISON.social }], location: { formatted_address: POISON.address }, video: { url: POISON.video },
    });
    assert('⛔ availableFieldsOf a poisoned set returns the seven NAMES and no value', () =>
        JSON.stringify(names) === JSON.stringify([...LISTING_CONTACT_FIELDS]) && leaks(names).length === 0);
    assert('empty values are not available fields', () =>
        availableFieldsOf({ whatsapp: '', phone: null, socials: [], location: null, video: { url: '' } }).length === 0);

    // ─── § 12 Settings ──────────────────────────────────────────────────────
    console.log('\n§ 12 listing settings (L-10, L-11, L-30)');

    const s = (over: Record<string, unknown>) => ({ onEmpty: 'continue_engaged' as const, debtFloor: null, maxCreditsPerCustomerPerDay: null, ...over });
    assert('the defaults are valid', () => settingsProblem(s({}), 7) === null);
    assert('⛔ a positive debt floor is refused', () => settingsProblem(s({ debtFloor: 5 }), 7) !== null);
    assert('a zero or negative floor is fine', () => settingsProblem(s({ debtFloor: 0 }), 7) === null && settingsProblem(s({ debtFloor: -50 }), 7) === null);
    assert('⛔ a daily cap under the first-reveal cost is refused; at the cost it is fine', () =>
        settingsProblem(s({ maxCreditsPerCustomerPerDay: 6 }), 7) !== null && settingsProblem(s({ maxCreditsPerCustomerPerDay: 7 }), 7) === null);
    assert('the settings body is the whole object, typed (400 on a string number)', () =>
        ListingSettingsSchema.safeParse(s({})).success && !ListingSettingsSchema.safeParse(s({ debtFloor: '-5' })).success
        && !ListingSettingsSchema.safeParse({ onEmpty: 'stop' }).success);

    // ─── § 13 oEmbed ────────────────────────────────────────────────────────
    console.log('\n§ 13 the YouTube oEmbed verdicts (no network)');

    const checker = (status: number | 'throw') => new YoutubeOembedChecker(async () => {
        if (status === 'throw') throw Object.assign(new Error('down'), { name: 'AbortError' });
        return { status };
    }, 50);
    await assertAsync('200 → watchable', async () => (await checker(200).check('https://youtu.be/a')) === 'watchable');
    await assertAsync('⛔ 401 / 403 / 404 → gone', async () =>
        (await checker(401).check('u')) === 'gone' && (await checker(403).check('u')) === 'gone' && (await checker(404).check('u')) === 'gone');
    await assertAsync('⛔ a network error or timeout → unknown (fail OPEN)', async () => (await checker('throw').check('u')) === 'unknown');
    await assertAsync('a 500 or 429 → unknown', async () =>
        (await checker(500).check('u')) === 'unknown' && (await checker(429).check('u')) === 'unknown');
    assert('the oEmbed URL encodes the video link', () =>
        oembedUrlFor('https://www.youtube.com/watch?v=a&t=1') === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Da%26t%3D1&format=json');

    // ─── § 14 Submit / withdraw on stubs ────────────────────────────────────
    console.log('\n§ 14 submit / withdraw — fee, quota, oEmbed, pre-flags, CAS refund');

    // The detail read at the end of each action resolves categories; no DB here.
    (categoryCatalogCache as unknown as { refsFor: () => Promise<unknown[]> }).refsFor = async () => [];

    const vendorId = new Types.ObjectId().toString();
    const listingId = new Types.ObjectId().toString();
    type Calls = { debit: number; credit: number; creditInSession: number; quota: number; cas: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>; oembed: number; contactWrites: unknown[] };
    function harness(opts: {
        status?: string; reviewState?: string; published?: boolean; pending?: Record<string, unknown>;
        contacts?: unknown; oembed?: 'watchable' | 'gone' | 'unknown'; casMiss?: boolean; quotaFull?: boolean;
    }) {
        const calls: Calls = { debit: 0, credit: 0, creditInSession: 0, quota: 0, cas: [], oembed: 0, contactWrites: [] };
        const row = {
            _id: new Types.ObjectId(listingId), vendor_id: new Types.ObjectId(vendorId), slug: 's',
            status: opts.status ?? 'draft',
            published: opts.published ? { ...COMPLETE, description_rich: null, photo_file_ids: [], opening_hours: null } : null,
            pending: { ...COMPLETE, description_rich: null, photo_file_ids: [], opening_hours: null, ...(opts.pending ?? {}) },
            review: { state: opts.reviewState ?? 'editing', index_fee_ref: opts.reviewState === 'pending_review' ? 'fee-1' : null, reasons: [] },
            available_fields: [], vectorised_data_id: null, published_at: null,
        };
        const svc = new ListingProviderService(
            {
                findOwned: async () => row,
                countOccupyingSlots: async () => 0,
                casUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
                    calls.cas.push({ filter, update });
                    return opts.casMiss ? null : row;
                },
            } as never,
            {
                getForOwner: async () => ({ published: null, pending: opts.contacts === undefined ? { ...applyContactsPatch(null, { whatsapp: '+237670000001' }) } : opts.contacts }),
                upsertPending: async (_l: string, _v: string, set: unknown) => { calls.contactWrites.push(set); },
            } as never,
            {
                debit: async () => { calls.debit++; return {}; },
                credit: async () => { calls.credit++; return {}; },
                creditInSession: async () => { calls.creditInSession++; return { owner_type: 'vendor', owner_id: new Types.ObjectId(vendorId), balance: 100 }; },
            } as never,
            {
                assertCanAddListings: async () => {
                    calls.quota++;
                    if (opts.quotaFull) throw Object.assign(new Error('full'), { code: ERROR_CODES.BILLING_LIMIT_EXCEEDED, statusCode: 403 });
                },
            } as never,
            { resolveForWrite: async () => [] } as never,
            { check: async () => { calls.oembed++; return opts.oembed ?? 'watchable'; } } as never,
            { reconcileVendor: async () => ({}) } as never,
            { deindex: async () => undefined } as never,
            { findManyByIds: async () => [] } as never,
            { reconcile: async () => undefined } as never,
            { runInTransactionWithRetry: async (fn: (s: unknown) => Promise<unknown>) => fn({}) } as never,
            { latestFeeRowId: async () => 'fee-row-1', amountOf: async () => 5 } as never,
        );
        return { svc, calls, row };
    }

    await assertAsync('⛔ an incomplete listing is 422 LISTING_INCOMPLETE with details.missing, and nothing is charged', async () => {
        const h = harness({ pending: { title: 'ab', area: '' } });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        const missing = (err as { details?: { missing?: string[] } }).details?.missing ?? [];
        return codeOf(err) === ERROR_CODES.LISTING_INCOMPLETE && statusOf(err) === 422
            && JSON.stringify(missing) === JSON.stringify(['title', 'area']) && h.calls.debit === 0;
    });
    await assertAsync('⛔ no contact field → 422 with missing [contact]', async () => {
        const h = harness({ contacts: null });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        return codeOf(err) === ERROR_CODES.LISTING_INCOMPLETE
            && JSON.stringify((err as { details?: { missing?: string[] } }).details?.missing) === JSON.stringify(['contact']);
    });
    await assertAsync('⛔ a private / deleted YouTube video is 422 LISTING_VIDEO_NOT_WATCHABLE, nothing charged', async () => {
        const h = harness({ oembed: 'gone', contacts: applyContactsPatch(null, { whatsapp: '+237670000001', video: { url: 'https://youtu.be/abc' } }) });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        return codeOf(err) === ERROR_CODES.LISTING_VIDEO_NOT_WATCHABLE && statusOf(err) === 422 && h.calls.debit === 0;
    });
    await assertAsync('⛔ oEmbed unreachable → accepted with checked_at null (fail open)', async () => {
        const h = harness({ oembed: 'unknown', contacts: applyContactsPatch(null, { whatsapp: '+237670000001', video: { url: 'https://youtu.be/abc' } }) });
        await h.svc.submit(vendorId, listingId);
        const written = h.calls.contactWrites[0] as { video?: { checked_at: Date | null } };
        return h.calls.debit === 1 && written?.video?.checked_at === null;
    });
    await assertAsync('a watchable YouTube video is stamped checked_at', async () => {
        const h = harness({ contacts: applyContactsPatch(null, { whatsapp: '+237670000001', video: { url: 'https://youtu.be/abc' } }) });
        await h.svc.submit(vendorId, listingId);
        const written = h.calls.contactWrites[0] as { video?: { checked_at: Date | null } };
        return written?.video?.checked_at instanceof Date;
    });
    await assertAsync('a Drive video is not sent to oEmbed', async () => {
        const h = harness({ contacts: applyContactsPatch(null, { whatsapp: '+237670000001', video: { url: 'https://drive.google.com/file/d/1/view' } }) });
        await h.svc.submit(vendorId, listingId);
        return h.calls.oembed === 0;
    });
    await assertAsync('⛔ a first submission debits the fee, checks the quota and moves to pending_review with the fee ref', async () => {
        const h = harness({ pending: { description: 'Call 6 77 12 34 56 for leaks and pipes.' } });
        await h.svc.submit(vendorId, listingId);
        const set = (h.calls.cas[0].update as { $set: Record<string, unknown> }).$set;
        const preflags = set['review.preflags'] as Array<{ kind: string }>;
        return h.calls.debit === 1 && h.calls.quota === 1 && set.status === 'pending_review'
            && set['review.state'] === 'pending_review' && set['review.index_fee_ref'] === 'fee-row-1'
            && preflags.some((p) => p.kind === 'phone');
    });
    await assertAsync('⛔ a revision of a live listing is NOT checked against the quota and stays live', async () => {
        const h = harness({ status: 'live', published: true });
        await h.svc.submit(vendorId, listingId);
        const set = (h.calls.cas[0].update as { $set: Record<string, unknown> }).$set;
        return h.calls.quota === 0 && set.status === 'live' && h.calls.debit === 1;
    });
    await assertAsync('⛔ over the plan → 403 BILLING_LIMIT_EXCEEDED before any charge', async () => {
        const h = harness({ quotaFull: true });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        return codeOf(err) === ERROR_CODES.BILLING_LIMIT_EXCEEDED && h.calls.debit === 0;
    });
    await assertAsync('⛔ a lost compare-and-set after the debit refunds the fee and answers 409', async () => {
        const h = harness({ casMiss: true });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        return codeOf(err) === ERROR_CODES.LISTING_STATUS_CONFLICT && statusOf(err) === 409 && h.calls.debit === 1 && h.calls.credit === 1;
    });
    await assertAsync('⛔ submitting while already pending_review is 409 and charges nothing', async () => {
        const h = harness({ reviewState: 'pending_review', status: 'pending_review' });
        const err = await thrownAsync(() => h.svc.submit(vendorId, listingId));
        return codeOf(err) === ERROR_CODES.LISTING_STATUS_CONFLICT && h.calls.debit === 0;
    });
    await assertAsync('⛔ the submit CAS names the state it read (status + review.state)', async () => {
        const h = harness({});
        await h.svc.submit(vendorId, listingId);
        const filter = h.calls.cas[0].filter;
        return filter.status === 'draft' && filter['review.state'] === 'editing';
    });
    await assertAsync('⛔ withdraw refunds the fee inside the transaction and returns a draft to draft', async () => {
        const h = harness({ reviewState: 'pending_review', status: 'pending_review' });
        await h.svc.withdraw(vendorId, listingId);
        const set = (h.calls.cas[0].update as { $set: Record<string, unknown> }).$set;
        return h.calls.creditInSession === 1 && set.status === 'draft' && (set.review as { state: string }).state === 'editing';
    });
    await assertAsync('withdraw of a live listing\'s revision keeps it live', async () => {
        const h = harness({ reviewState: 'pending_review', status: 'live', published: true });
        await h.svc.withdraw(vendorId, listingId);
        return ((h.calls.cas[0].update as { $set: Record<string, unknown> }).$set.status) === 'live';
    });
    await assertAsync('⛔ PATCH while pending_review is 409 LISTING_STATUS_CONFLICT', async () => {
        const h = harness({ reviewState: 'pending_review', status: 'pending_review' });
        const err = await thrownAsync(() => h.svc.update(vendorId, listingId, { content: { title: 'New title' } }));
        return codeOf(err) === ERROR_CODES.LISTING_STATUS_CONFLICT && statusOf(err) === 409;
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
