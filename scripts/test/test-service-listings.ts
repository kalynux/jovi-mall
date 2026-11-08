/**
 * test:service-listings — informational service listings, walk-order step 1 (DB-free).
 *
 * Plan: PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md (L-1, L-2, L-26, § C-1 … § C-7).
 * Later steps live in their own suites (`test:service-listings-*`) so builders working in
 * parallel never edit one file; this one pins the vendor kind and the contact-blocking locks.
 *
 *   § 1  the vendor-kind helpers — what a MISSING kind means
 *   § 2  `requireVendorKind` — behaviour on a fake request
 *   § 3  ⛔ every vendor router declares its kind (the source scan the plan requires)
 *   § 4  registration / add-role: the kind is chosen there, and a provider gets no Store
 *   § 5  ⛔ L-26 — no provider contact on a public / bot / vectoriser path
 *   § 6  the index migration matches the schemas it claims to build
 *   § 7  the pre-registered names exist (codes, ledger reasons, ticket enums, costs)
 *
 * Every ⛔ guard here was mutation-proven when written: break the guarded line, watch the
 * named assertion fail, restore it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import {
    VENDOR_KINDS,
    vendorKindOf,
    isProviderVendor,
    vendorKindForRole,
    newVendorKindFields,
    providerCountryOf,
    SELLER_VENDOR_FILTER,
} from '../../src/modules/vendors/domain/vendor-kind';
import { requireVendorKind } from '../../src/api/middlewares/vendor-kind.middleware';
import { RegisterSchema, AddRoleSchema } from '../../src/modules/auth/auth.schemas';
import { StoreProvisioningService } from '../../src/modules/store/service/store-provisioning.service';
import { ERROR_CODES } from '../../src/core/error-codes';
import { buildAccentInsensitiveSearchRegex } from '../../src/core/utils/regex.util';
import { VendorListingListQuerySchema } from '../../src/modules/listings/validators/listing.validator';
import { COLLECTIONS, MODELS } from '../../src/core/database/collections';
import { CREDIT_REASON_CODES } from '../../src/modules/billing/models/credit-transaction.model';
import { TicketType, EntityType } from '../../src/modules/tickets/types/ticket.types';
import { LISTING_REVEAL_FIRST_COST, LISTING_REVEAL_NEXT_COST } from '../../src/modules/billing/config/credit.config';
import {
    LISTING_CONTACT_FIELDS,
    DEFAULT_LISTING_SETTINGS,
} from '../../src/modules/listings/domain/listing.types';
import { PLANNED } from '../migrate-service-listings-indexes';
import { ListingModel } from '../../src/modules/listings/models/listing.model';
import { ListingContactModel } from '../../src/modules/listings/models/listing-contact.model';
import { ListingLeadModel } from '../../src/modules/listings/models/listing-lead.model';
import { ListingRevealModel } from '../../src/modules/listings/models/listing-reveal.model';
import { ListingRevealBlockModel } from '../../src/modules/listings/models/listing-reveal-block.model';
import { ProviderContactConsentModel } from '../../src/modules/listings/models/provider-contact-consent.model';
import { ProviderCustomerMessageModel } from '../../src/modules/listings/models/provider-customer-message.model';

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
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Drop comments so a header that QUOTES a guard cannot satisfy the scan.
 *
 * ⚠ A character walk, not a regex. The obvious `replace(/\/\*[\s\S]*?\*\//g, '')` was tried
 * first and silently deleted real code: `api/index.ts` has line comments mentioning
 * `/api/vendor/*`, whose `/*` opened a "block comment" that ran to the next `*\/` and took
 * `router.use('/vendor', vendorEarningsRoutes)` with it. Strings are honoured so a `//` in a
 * URL literal is not a comment either.
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

function routeFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            // `routes.ts` as well as `*.routes.ts`: vendor/routes.ts and store/routes.ts are
            // named plainly, and a `.routes.ts`-only filter (wi-admin's) would miss both.
            else if (/(^|\.)routes\.ts$/.test(entry)) out.push(full);
        }
    };
    walk(SRC);
    return out.sort();
}

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

function runGuard(guard: ReturnType<typeof requireVendorKind>, auth: unknown): { error: unknown; called: boolean } {
    let error: unknown = undefined;
    let called = false;
    guard({ auth } as never, {} as never, (err?: unknown) => { called = true; error = err; });
    return { error, called };
}
const codeOf = (err: unknown): string | undefined => (err as { code?: string } | undefined)?.code;
const statusOf = (err: unknown): number | undefined => (err as { statusCode?: number } | undefined)?.statusCode;

async function main(): Promise<void> {
    // ─── § 1 Vendor-kind helpers ─────────────────────────────────────────────
    console.log('\n§ 1 the vendor kind — what a missing value means');

    assert('exactly two kinds, seller and provider', () =>
        JSON.stringify([...VENDOR_KINDS]) === JSON.stringify(['seller', 'provider']));
    assert('⛔ a vendor with NO kind (every pre-2026-10-19 vendor) is a seller', () =>
        vendorKindOf({}) === 'seller' && vendorKindOf(null) === 'seller' && vendorKindOf(undefined) === 'seller');
    assert('an unknown kind value reads as seller, never as provider', () =>
        vendorKindOf({ kind: 'Provider' }) === 'seller' && vendorKindOf({ kind: 42 }) === 'seller');
    assert('only the literal `provider` is a provider', () =>
        isProviderVendor({ kind: 'provider' }) && !isProviderVendor({ kind: 'seller' }) && !isProviderVendor({}));
    assert('⛔ the seller filter is `$ne: provider` — it matches vendors with no kind', () =>
        JSON.stringify(SELLER_VENDOR_FILTER) === JSON.stringify({ kind: { $ne: 'provider' } }));
    assert('auth responses: vendorKind is the kind for a vendor session, null for every other role', () =>
        vendorKindForRole('vendor', { kind: 'provider' }) === 'provider'
        && vendorKindForRole('vendor', {}) === 'seller'
        && vendorKindForRole('customer', { kind: 'provider' }) === null
        && vendorKindForRole(undefined, null) === null);
    assert('a NEW provider starts COMPLETED (onboarding_step 0) with the default listing settings', () => {
        const f = newVendorKindFields('provider', '+237672745831');
        return f.kind === 'provider' && f.onboarding_step === 0
            && JSON.stringify(f.listing_settings) === JSON.stringify(DEFAULT_LISTING_SETTINGS);
    });
    // 2026-11-08: a provider never sees onboarding Step 1, where a seller sets the country.
    assert('a NEW provider gets its country from the sign-up phone (+237 → CM, +225 → CI)', () =>
        newVendorKindFields('provider', '+237672745831').country === 'CM'
        && newVendorKindFields('provider', '+2250701020304').country === 'CI'
        && providerCountryOf('+33612345678') === 'FR');
    assert('…and Cameroon when there is no phone, or it matches no country', () =>
        providerCountryOf(null) === 'CM' && providerCountryOf(undefined) === 'CM' && providerCountryOf('+999123456') === 'CM'
        && newVendorKindFields('provider').country === 'CM');
    assert('a NEW seller gets its kind written explicitly and nothing else changed', () =>
        JSON.stringify(newVendorKindFields('seller')) === JSON.stringify({ kind: 'seller' }));
    assert('the default on-empty behaviour is continue_engaged, no floor, no daily cap (L-10, L-11, L-30)', () =>
        DEFAULT_LISTING_SETTINGS.on_empty === 'continue_engaged'
        && DEFAULT_LISTING_SETTINGS.debt_floor === null
        && DEFAULT_LISTING_SETTINGS.max_credits_per_customer_per_day === null);

    // ─── § 2 requireVendorKind ──────────────────────────────────────────────
    console.log('\n§ 2 requireVendorKind on a fake request');

    const sellerGuard = requireVendorKind('seller');
    const providerGuard = requireVendorKind('provider');
    const bothGuard = requireVendorKind('both');
    const providerAuth = { role: 'vendor', role_entity: { kind: 'provider' } };
    const legacySellerAuth = { role: 'vendor', role_entity: { status: 'active' } };

    assert('⛔ a provider on a seller route: 403 AUTH_VENDOR_KIND_FORBIDDEN, details.required = seller', () => {
        const r = runGuard(sellerGuard, providerAuth);
        return codeOf(r.error) === ERROR_CODES.AUTH_VENDOR_KIND_FORBIDDEN && statusOf(r.error) === 403
            && (r.error as { details?: { required?: string } }).details?.required === 'seller';
    });
    assert('⛔ a legacy vendor with no kind passes a seller route (nothing changes for today\'s sellers)', () => {
        const r = runGuard(sellerGuard, legacySellerAuth);
        return r.called && r.error === undefined;
    });
    assert('a seller on a provider route: 403, required = provider', () => {
        const r = runGuard(providerGuard, legacySellerAuth);
        return codeOf(r.error) === ERROR_CODES.AUTH_VENDOR_KIND_FORBIDDEN
            && (r.error as { details?: { required?: string } }).details?.required === 'provider';
    });
    assert('a provider passes a provider route', () => {
        const r = runGuard(providerGuard, providerAuth);
        return r.called && r.error === undefined;
    });
    assert('`both` is a declaration that always passes', () =>
        runGuard(bothGuard, providerAuth).error === undefined && runGuard(bothGuard, legacySellerAuth).error === undefined);
    assert('a non-vendor session passes (requireRole decides roles, this guard decides kinds)', () =>
        runGuard(sellerGuard, { role: 'customer', role_entity: {} }).error === undefined);
    assert('no session at all: 401 AUTH_MISSING_TOKEN', () =>
        codeOf(runGuard(sellerGuard, undefined).error) === ERROR_CODES.AUTH_MISSING_TOKEN);

    // ─── § 3 The router source scan ─────────────────────────────────────────
    console.log('\n§ 3 ⛔ every vendor router declares its kind');

    const files = routeFiles();
    const sources = new Map(files.map((f) => [rel(f), stripComments(readFileSync(f, 'utf8'))]));

    /**
     * Routers that authenticate but name NO role: any role reaches them, so a vendor of
     * either kind does. Each is classified here, with the reason it is safe for a provider.
     * A NEW router of this shape fails the scan until somebody adds it here — that is the
     * point: an unclassified authenticated router is how a seller feature reaches providers.
     */
    const ROLE_AGNOSTIC: Record<string, string> = {
        'src/api/routes/file-upload.routes.ts': 'storage — a provider has storage (L-2)',
        'src/modules/auth/auth.routes.ts': 'sign-in, me, add-role — every role',
        'src/modules/auth/routes/mobile-auth.routes.ts': 'the bearer twin of auth.routes',
        'src/modules/catalog/routes/product-booking.routes.ts': 'a customer booking a slot; refuses nothing by role today, and a provider has no products to book against',
        'src/modules/geo/routes.ts': 'address search — a provider geocodes their listing location',
        'src/modules/payment-methods/routes.ts': 'saved payment methods — a provider pays for plans and credits',
        'src/modules/payments/routes/payment.routes.ts': 'customer order payments, owner-checked; a provider has no orders',
        'src/modules/tracking-integration/routes/tracking.routes.ts': 'visible-agents answers nothing for a vendor',
        'src/modules/users/user.routes.ts': '/api/me — password, contact, closure, consents: every role',
        'src/modules/referrals/routes/me-referral.routes.ts': '/api/me/referral — the referral program is open to every role (REFERRAL-PROGRAM-PLAN), a provider included',
    };

    const VENDOR_ROLE = /requireRole\(\s*\[[^\]]*'vendor'/;
    const ROLE_FACTORY = /requireRole\(\s*\[\s*role\s*\]\s*\)/; // buildKycRouter(role)
    const offenders: string[] = [];
    const agnosticUnclassified: string[] = [];
    let vendorRouters = 0;

    for (const [file, code] of sources) {
        const admitsVendor = VENDOR_ROLE.test(code) || ROLE_FACTORY.test(code);
        const declares = /requireVendorKind\(\s*'(seller|provider|both)'\s*\)/.test(code);
        if (admitsVendor) {
            vendorRouters++;
            if (!declares) offenders.push(file);
        } else if (/\brequireAuth\b/.test(code) && !/\brequireRole\(/.test(code) && !declares) {
            if (!ROLE_AGNOSTIC[file]) agnosticUnclassified.push(file);
        }
    }
    if (offenders.length) console.error(`      undeclared vendor routers: ${offenders.join(', ')}`);
    if (agnosticUnclassified.length) console.error(`      unclassified role-agnostic routers: ${agnosticUnclassified.join(', ')}`);

    assert('the scan saw the vendor routers (sanity: at least 15)', () => vendorRouters >= 15);
    assert('⛔ every router that admits a vendor declares requireVendorKind(seller | provider | both)', () =>
        offenders.length === 0);
    assert('⛔ every authenticated router with NO role guard is classified as role-agnostic, with a reason', () =>
        agnosticUnclassified.length === 0);
    assert('the role-agnostic list names only files that exist', () =>
        Object.keys(ROLE_AGNOSTIC).every((f) => sources.has(f)));

    // The bare-`/vendor` mounts: a sub-router's `use` runs for every LATER /vendor/* mount.
    const indexSrc = stripComments(read('src/api/index.ts'));
    const bareVendorMounts = [...indexSrc.matchAll(/router\.use\(\s*'\/vendor'\s*,\s*(\w+)\s*\)/g)].map((m) => m[1]).sort();
    assert('⛔ exactly three routers are mounted at bare /vendor (a fourth must be added to this list)', () =>
        JSON.stringify(bareVendorMounts) === JSON.stringify(['vendorBillingRoutes', 'vendorEarningsRoutes', 'vendorRoutes']));

    const BARE: Record<string, string> = {
        vendorRoutes: 'src/modules/vendor/routes.ts',
        vendorBillingRoutes: 'src/modules/billing/routes/vendor-billing.routes.ts',
        vendorEarningsRoutes: 'src/modules/earnings/routes/vendor-earnings.routes.ts',
    };
    for (const [name, file] of Object.entries(BARE)) {
        const code = sources.get(file) ?? '';
        assert(`⛔ ${name}: no router-level seller/provider guard (it would leak onto every later /vendor/* mount)`, () =>
            code.length > 0 && !/\.use\(\s*requireVendorKind\(\s*'(seller|provider)'/.test(code));
    }
    for (const file of ['src/modules/vendor/routes.ts', 'src/modules/earnings/routes/vendor-earnings.routes.ts']) {
        const code = sources.get(file) ?? '';
        const routeLines = code.split('\n').filter((l) => /\brouter\.(get|post|put|patch|delete)\(/.test(l));
        const bare = routeLines.filter((l) => !/,\s*(SELLER|BOTH|PROVIDER)\s*,/.test(l));
        if (bare.length) console.error(`      routes with no kind token in ${file}:\n        ${bare.join('\n        ')}`);
        assert(`⛔ ${file}: every route carries SELLER / BOTH / PROVIDER`, () =>
            routeLines.length > 0 && bare.length === 0);
    }
    assert('vendor/routes.ts: orders are SELLER, the profile is BOTH', () => {
        const code = sources.get('src/modules/vendor/routes.ts') ?? '';
        return /router\.get\('\/orders', SELLER,/.test(code) && /router\.get\('\/profile', BOTH,/.test(code)
            && /router\.put\('\/onboarding\/basic-setup', SELLER,/.test(code);
    });
    assert('the store, products, earnings, bookings and agency-link routers are SELLER', () =>
        ['src/modules/store/routes.ts', 'src/modules/catalog/routes/vendor-products.routes.ts',
            'src/modules/booking/routes/vendor-booking.routes.ts',
            'src/modules/agency-connections/routes/vendor-connection.routes.ts',
            'src/modules/ai-copy/routes/vendor-ai-copy.routes.ts']
            .every((f) => /requireVendorKind\('seller'\)/.test(sources.get(f) ?? '')));
    assert('billing, transactions, tickets, KYC and categories are BOTH', () =>
        ['src/modules/billing/routes/vendor-billing.routes.ts', 'src/modules/transactions/routes/vendor-transaction.routes.ts',
            'src/modules/tickets/routes/vendor-ticket.routes.ts', 'src/modules/identity-verification/routes/kyc.routes.ts',
            'src/modules/categories/routes/vendor-category.routes.ts']
            .every((f) => /requireVendorKind\('both'\)/.test(sources.get(f) ?? '')));
    assert('tickets: the order/product reference lookups are SELLER per route', () => {
        const code = sources.get('src/modules/tickets/routes/vendor-ticket.routes.ts') ?? '';
        return /'\/reference\/orders',\s*requireVendorKind\('seller'\)/.test(code)
            && /'\/reference\/products',\s*requireVendorKind\('seller'\)/.test(code);
    });

    // ─── § 4 Registration ───────────────────────────────────────────────────
    console.log('\n§ 4 the kind is chosen at registration; a provider gets no Store');

    const base = { phone: '+237670000001', name: 'Jean Plumber', password: 'secret123', terms_accepted: true };
    assert('register accepts vendorKind: provider with role vendor', () =>
        RegisterSchema.safeParse({ ...base, role: 'vendor', vendorKind: 'provider' }).success);
    assert('register without vendorKind still registers a vendor (every existing client is unchanged)', () => {
        const r = RegisterSchema.safeParse({ ...base, role: 'vendor' });
        return r.success && (r.data as { vendorKind?: string }).vendorKind === undefined;
    });
    assert('vendorKind with any other role is a 400', () =>
        !RegisterSchema.safeParse({ ...base, role: 'agency', vendorKind: 'provider' }).success);
    assert('an unknown kind is a 400', () =>
        !RegisterSchema.safeParse({ ...base, role: 'vendor', vendorKind: 'plumber' }).success);
    assert('add-role carries the same rule', () =>
        AddRoleSchema.safeParse({ role: 'vendor', vendorKind: 'provider', terms_accepted: true }).success
        && !AddRoleSchema.safeParse({ role: 'agent', vendorKind: 'seller' }).success);

    const authSrc = stripComments(read('src/modules/auth/auth.service.ts'));
    const vendorCases = authSrc.split("case 'vendor':").slice(1).map((s) => s.slice(0, 900));
    assert('⛔ register AND add-role write the kind fields on the new vendor row', () =>
        vendorCases.length === 2
        && vendorCases[0].includes('...newVendorKindFields(kind, input.phone)')
        && vendorCases[1].includes('...newVendorKindFields(kind, user.login_phone)'));
    assert('⛔ register AND add-role provision a Store only for a seller', () =>
        vendorCases.every((c) => /if \(kind === 'seller'\) \{\s*await this\.storeProvisioning\.ensureStoreForVendor/.test(c)));

    await assertAsync('⛔ ensureStoreForVendor REFUSES a provider (the single creation path, all seven call sites)', async () => {
        const svc = new StoreProvisioningService() as unknown as {
            storeRepo: unknown; vendorRepo: unknown;
            ensureStoreForVendor: (id: string) => Promise<unknown>;
        };
        let created = false;
        svc.storeRepo = {
            findByVendorIdOrNull: async () => null,
            findBySlug: async () => null,
            create: async () => { created = true; return {}; },
        };
        svc.vendorRepo = { findById: async () => ({ _id: new mongoose.Types.ObjectId(), kind: 'provider', display_name: 'P' }) };
        try {
            await svc.ensureStoreForVendor(new mongoose.Types.ObjectId().toString());
            return false;
        } catch (err) {
            return codeOf(err) === ERROR_CODES.AUTH_VENDOR_KIND_FORBIDDEN && !created;
        }
    });
    await assertAsync('ensureStoreForVendor still creates a store for a legacy (kind-less) vendor', async () => {
        const svc = new StoreProvisioningService() as unknown as {
            storeRepo: unknown; vendorRepo: unknown;
            ensureStoreForVendor: (id: string) => Promise<unknown>;
        };
        let created = false;
        svc.storeRepo = {
            findByVendorIdOrNull: async () => null,
            findBySlug: async () => null,
            create: async (doc: unknown) => { created = true; return doc; },
        };
        svc.vendorRepo = { findById: async () => ({ _id: new mongoose.Types.ObjectId(), display_name: 'Maison Bella' }) };
        await svc.ensureStoreForVendor(new mongoose.Types.ObjectId().toString());
        return created;
    });

    const profileSrc = stripComments(read('src/modules/vendor/service/vendor-profile.service.ts'));
    assert('⛔ a provider\'s onboarding step never recalculates back into the seller checklist', () =>
        /private recalculateOnboardingStep\(vendor: IVendor\): VendorOnboardingStepValue \{\s*if \(isProviderVendor\(vendor\)\) return VendorOnboardingStep\.COMPLETED;/.test(profileSrc));

    const authCtrl = stripComments(read('src/modules/auth/auth.controller.ts'));
    const mobileCtrl = stripComments(read('src/modules/auth/controllers/mobile-auth.controller.ts'));
    assert('every cookie auth response carries vendorKind (register, login, me, auth-me, add-role)', () =>
        (authCtrl.match(/vendorKind: vendorKindForRole\(/g) ?? []).length === 5);
    assert('every bearer auth response carries vendorKind (login, register, auth-me, add-role)', () =>
        (mobileCtrl.match(/vendorKind: vendorKindForRole\(/g) ?? []).length === 4);

    // ─── § 5 L-26 ───────────────────────────────────────────────────────────
    console.log('\n§ 5 ⛔ L-26 — a provider\'s contact reaches no public, bot or vectoriser payload');

    const publicRepo = stripComments(read('src/modules/catalog/repositories/mongo/public-catalog.repository.mongo.ts'));
    const findOneStore = publicRepo.slice(publicRepo.indexOf('private async findOneStore'), publicRepo.indexOf('private async findOneStore') + 4000);
    assert('⛔ the public store page (the one read serving zero-product stores) excludes provider vendors', () =>
        findOneStore.includes("{ $match: { 'vendor.kind': { $ne: 'provider' } } }") && /kind: 1,/.test(findOneStore));

    const vecSrc = stripComments(read('src/modules/catalog/domain/services/VectorisationService.ts'));
    assert('⛔ the product vectoriser payload sends a seller\'s email and never a provider\'s', () =>
        vecSrc.includes('email: isProviderVendor(vendorDoc) ? null : vendorDoc.email,')
        && !/email: vendorDoc\.email,/.test(vecSrc));

    const vendorRepoSrc = stripComments(read('src/modules/vendors/vendor.repository.ts'));
    const browse = vendorRepoSrc.slice(vendorRepoSrc.indexOf('async findAvailableForAgencies'), vendorRepoSrc.indexOf('async findAvailableForAgencies') + 800);
    assert('⛔ the agency vendor directory (which carries an address line) never lists a provider', () =>
        browse.includes('...SELLER_VENDOR_FILTER'));

    const connSrc = stripComments(read('src/modules/agency-connections/connection.service.ts'));
    assert('an agency cannot open a connection to a provider', () =>
        /if \(isProviderVendor\(vendor\)\) throw createAppError\(ERROR_CODES\.CONNECTION_VENDOR_NOT_FOUND, 404\);/.test(connSrc));

    const storeDto = stripComments(read('src/modules/store/dto/public-store.dto.ts'));
    assert('L-26 leaves SELLERS unchanged: the public store DTO still publishes a seller\'s support contacts', () =>
        storeDto.includes('supportEmail: store.support_email ?? null')
        && storeDto.includes('supportWhatsapp'));

    // The SENSITIVE collection: only its own model file and the documented readers may name it.
    // Wave 0 has no readers yet; later steps extend ALLOWED_CONTACT_READERS with each one, and
    // `test:service-listings-*` pins the list for its own step.
    const contactImporters = [...sources.keys()].length >= 0
        ? (() => {
            const found: string[] = [];
            const walk = (dir: string): void => {
                for (const entry of readdirSync(dir)) {
                    const full = path.join(dir, entry);
                    if (statSync(full).isDirectory()) walk(full);
                    else if (entry.endsWith('.ts')) {
                        const code = stripComments(readFileSync(full, 'utf8'));
                        if (/listing-contact\.model'|ListingContactModel\b|COLLECTIONS\.LISTING_CONTACT\b/.test(code)) found.push(rel(full));
                    }
                }
            };
            walk(SRC);
            return found.sort();
        })()
        : [];
    const CONTACT_MODEL_HOME = 'src/modules/listings/models/listing-contact.model.ts';
    const ALLOWED_CONTACT_READERS = new Set<string>([
        CONTACT_MODEL_HOME,
        // The ONE door: the reveal, approve, provider-detail and role-closure eraser all go
        // through this repository (the closure manifest calls `eraseForVendor`).
        'src/modules/listings/repositories/listing-contact.repository.ts',
    ]);
    const strayReaders = contactImporters.filter((f) => !ALLOWED_CONTACT_READERS.has(f));
    if (strayReaders.length) console.error(`      listing_contacts reached from: ${strayReaders.join(', ')}`);
    assert('⛔ listing_contacts is named only by its model and its one repository (no index / DTO / list path)', () =>
        strayReaders.length === 0);

    const listingModelSrc = stripComments(read('src/modules/listings/models/listing.model.ts'));
    assert('⛔ the PUBLIC listings schema holds no contact-shaped field', () =>
        !/\b(whatsapp|phone|email|website|socials|video|coordinates|location)\s*:/.test(listingModelSrc));

    // ─── § 6 Index migration ────────────────────────────────────────────────
    console.log('\n§ 6 the index migration builds exactly what the schemas declare');

    const MODELS_BY_COLLECTION: Record<string, mongoose.Model<never>> = {
        [COLLECTIONS.LISTING]: ListingModel as never,
        [COLLECTIONS.LISTING_CONTACT]: ListingContactModel as never,
        [COLLECTIONS.LISTING_LEAD]: ListingLeadModel as never,
        [COLLECTIONS.LISTING_REVEAL]: ListingRevealModel as never,
        [COLLECTIONS.LISTING_REVEAL_BLOCK]: ListingRevealBlockModel as never,
        [COLLECTIONS.PROVIDER_CONTACT_CONSENT]: ProviderContactConsentModel as never,
        [COLLECTIONS.PROVIDER_CUSTOMER_MESSAGE]: ProviderCustomerMessageModel as never,
    };
    for (const planned of PLANNED) {
        assert(`index ${planned.collection}.${planned.name} is declared on its schema with the same key and options`, () => {
            const model = MODELS_BY_COLLECTION[planned.collection];
            if (!model) return false;
            const declared = model.schema.indexes().find(([, opts]) => (opts as { name?: string }).name === planned.name);
            if (!declared) return false;
            const [key, opts] = declared as [Record<string, unknown>, Record<string, unknown>];
            const sameKey = JSON.stringify(key) === JSON.stringify(planned.key);
            const wanted = planned.options ?? {};
            const sameOpts = Object.entries(wanted).every(([k, v]) => JSON.stringify(opts[k]) === JSON.stringify(v));
            return sameKey && sameOpts;
        });
    }
    assert('⛔ the reveal idempotency index is UNIQUE on (lead_id, field)', () =>
        PLANNED.some((p) => p.name === 'listing_reveal_one_per_field' && (p.options as { unique?: boolean }).unique === true
            && JSON.stringify(p.key) === JSON.stringify({ lead_id: 1, field: 1 })));
    assert('the migration is registered in the ledger above the catch-all, and bound in package.json', () => {
        const migrate = read('scripts/migrate.ts');
        const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
        const at = migrate.indexOf("name: 'migrate:service-listings-indexes'");
        return at > 0 && at < migrate.indexOf("name: 'migrate:declared-indexes'")
            && pkg.scripts['migrate:service-listings-indexes'] === 'ts-node scripts/migrate-service-listings-indexes.ts';
    });
    assert('listing_contacts carries no 2dsphere index (the pin is sensitive and nothing searches it)', () =>
        !ListingContactModel.schema.indexes().some(([key]) => Object.values(key).includes('2dsphere')));

    // ─── § 7 Pre-registered names ───────────────────────────────────────────
    console.log('\n§ 7 the contract names are registered');

    const CODES = [
        'AUTH_VENDOR_KIND_FORBIDDEN', 'LISTING_NOT_FOUND', 'LISTING_STATUS_CONFLICT', 'LISTING_INCOMPLETE',
        'LISTING_VIDEO_LINK_INVALID', 'LISTING_VIDEO_NOT_WATCHABLE', 'LISTING_VIDEO_UNAVAILABLE', 'LISTING_UNREACHABLE',
        'LISTING_REVEAL_DAILY_LIMIT', 'LISTING_FIELD_UNAVAILABLE', 'LISTING_REVEAL_NOT_FOUND',
        'LISTING_REVEAL_ALREADY_REFUNDED', 'LISTING_REVEAL_BLOCK_EXISTS', 'LISTING_REVEAL_BLOCK_NOT_FOUND',
        'LISTING_LEAD_NOT_FOUND', 'LISTING_MESSAGE_CONSENT_REQUIRED', 'LISTING_MESSAGE_CAP_REACHED',
        'LISTING_CALL_ME_ALREADY_SENT', 'LISTING_MESSAGE_WINDOW_CLOSED', 'LISTING_MESSAGE_CHANNEL_UNAVAILABLE',
        'LISTING_SETTINGS_INVALID', 'LISTING_REPORT_INVALID',
    ];
    assert(`all ${CODES.length} § C-4 error codes are declared`, () =>
        CODES.every((c) => (ERROR_CODES as Record<string, string>)[c] === c));
    assert('the three ledger reason codes are on the schema enum', () =>
        ['listing_reveal', 'listing_reveal_refund', 'credit_debt_written_off'].every((r) => CREDIT_REASON_CODES.includes(r as never)));
    assert('the ticket type and linked-entity type exist', () =>
        TicketType.LISTING_LEAD_REPORT === 'LISTING_LEAD_REPORT' && EntityType.LISTING_LEAD === 'LISTING_LEAD');
    assert('the seven collections are registered under MODELS and COLLECTIONS', () =>
        ['LISTING', 'LISTING_CONTACT', 'LISTING_LEAD', 'LISTING_REVEAL', 'LISTING_REVEAL_BLOCK',
            'PROVIDER_CONTACT_CONSENT', 'PROVIDER_CUSTOMER_MESSAGE']
            .every((k) => (MODELS as Record<string, string>)[k] && (COLLECTIONS as Record<string, string>)[k]));
    assert('reveal costs default to 7 and 4 (L-7)', () =>
        (process.env.CREDIT_COST_LISTING_REVEAL_FIRST !== undefined || LISTING_REVEAL_FIRST_COST === 7)
        && (process.env.CREDIT_COST_LISTING_REVEAL_NEXT !== undefined || LISTING_REVEAL_NEXT_COST === 4));
    assert('seven contact fields, so one customer costs at most FIRST + 6 × NEXT per window (31 by default)', () =>
        LISTING_CONTACT_FIELDS.length === 7
        && LISTING_REVEAL_FIRST_COST + (LISTING_CONTACT_FIELDS.length - 1) * LISTING_REVEAL_NEXT_COST
            === (process.env.CREDIT_COST_LISTING_REVEAL_FIRST || process.env.CREDIT_COST_LISTING_REVEAL_NEXT
                ? LISTING_REVEAL_FIRST_COST + 6 * LISTING_REVEAL_NEXT_COST : 31));
    assert('.env.example documents both reveal costs', () => {
        const env = read('.env.example');
        return env.includes('CREDIT_COST_LISTING_REVEAL_FIRST=7') && env.includes('CREDIT_COST_LISTING_REVEAL_NEXT=4');
    });

    // ─── § 8 Shared category list ───────────────────────────────────────────
    console.log('\n§ 8 an admin merge / delete of a category covers listings too');

    const catAdmin = stripComments(read('src/modules/categories/services/category-admin.service.ts'));
    const mergeSpan = catAdmin.slice(catAdmin.indexOf('async merge('), catAdmin.indexOf('async remove('));
    const removeSpan = catAdmin.slice(catAdmin.indexOf('async remove('), catAdmin.indexOf('private async mustFindLive'));
    assert('⛔ a merge rewrites BOTH listing copies (published and a pending revision)', () =>
        /'published\.category_ids': src/.test(mergeSpan) && /'pending\.category_ids': src/.test(mergeSpan)
        && /mergedIdsExpr\('\$published\.category_ids'/.test(mergeSpan) && /mergedIdsExpr\('\$pending\.category_ids'/.test(mergeSpan));
    assert('⛔ a delete is refused while a non-archived listing holds the category', () =>
        /ListingModel\.countDocuments\(LISTING_HOLDS_CATEGORY\(oid\)\)/.test(removeSpan)
        && /productCount > 0 \|\| listingCount > 0/.test(removeSpan)
        && /status: \{ \$ne: 'archived' \}/.test(catAdmin));

    // ── The provider's text search, GET /api/vendor/listings?q (2026-11-08) ──
    console.log('\n── Provider search: ?q on the listings list (2026-11-08) ──');
    const m = (q: string, s: string) => buildAccentInsensitiveSearchRegex(q).test(s);
    assert('?q is case- AND accent-insensitive, in both directions', () =>
        m('electricite', 'Électricité Akwa') && m('ÉLECTRICITÉ', 'electricite') && m('plomb', 'PLOMBERIE')
        && m('cafe', 'Café du Port') && m('nino', 'Niño') && !m('electricite', 'Plomberie'));
    assert('?q is matched LITERALLY: regex characters are escaped, never interpreted', () =>
        !m('a.b', 'axb') && m('a.b', 'a.b') && m('(x', 'Bar (x)') && !m('.*', 'anything'));
    assert('?q is 1–200 characters, trimmed, and combines with status', () =>
        VendorListingListQuerySchema.safeParse({ q: 'plomb', status: 'live' }).success
        && !VendorListingListQuerySchema.safeParse({ q: '' }).success
        && !VendorListingListQuerySchema.safeParse({ q: '   ' }).success
        && !VendorListingListQuerySchema.safeParse({ q: 'x'.repeat(201) }).success
        && VendorListingListQuerySchema.parse({ q: '  plomb ' }).q === 'plomb');
    const listOwned = stripComments(read('src/modules/listings/repositories/listing.repository.ts'));
    const listOwnedBody = listOwned.slice(listOwned.indexOf('async listOwned('), listOwned.indexOf('async countOccupyingSlots('));
    assert('⛔ the search stays scoped to the caller\'s own listings, and reads the working AND the live copy', () =>
        /const filter: Record<string, unknown> = \{ vendor_id: oid\(vendorId\) \};/.test(listOwnedBody)
        && /\['pending\.title', 'pending\.company_name', 'published\.title', 'published\.company_name'\]/.test(listOwnedBody)
        && /buildAccentInsensitiveSearchRegex\(q\)/.test(listOwnedBody) && !/new RegExp/.test(listOwnedBody));

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
