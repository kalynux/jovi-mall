/**
 * Test: the curated bot surface (`/api/internal/bot/*`, GAP-001).
 *
 * Follows the scripts/test convention — plain ts-node, hand-rolled asserts, no framework.
 * DB-free: the route table and the projections are pure by construction, the two Redis
 * stores are driven against a FAKE Redis that implements the real `SET NX` and
 * atomic-consume semantics, and the identity service takes its resolver by injection.
 *
 * ── THE ASSERTIONS THIS SUITE EXISTS FOR ─────────────────────────────────────
 *
 *   1. **The route table matches `api-doc/n8n/tools/catalog.json`, row for row.** The
 *      automation layer is GENERATED from that file. A method, a path or a `mutating`
 *      flag that drifts produces a caller that sends the wrong verb to the wrong URL, or —
 *      worse — one that believes a mutation is safe to retry when the backend does not.
 *      There is no shared package between the two, so this assertion IS the contract copy,
 *      exactly as `test:blog`'s fixture list is for wi-admin's block union.
 *
 *   2. **The identity is never a parameter.** A source scan: no file in the module may
 *      read a `customerId` or `userId` out of a body, and the envelope schema is `.strict()`
 *      so one sent anyway is a 400 rather than a silently stripped field. On a surface that
 *      reaches carts, orders and addresses, a caller-supplied identity is account takeover.
 *
 *   3. **No session is ever minted.** A source scan for `issueTokenPair`, `setAuthCookies`
 *      and the login-session store. The whole design rests on the automation layer never
 *      holding a customer credential, and a passwordless customer has NO revocation path —
 *      `password_changed_at` is this service's only lever and they have never set it.
 *
 *   4. **The COD delivery code does not ride along.** Structural, not a regex: the
 *      collection object is rebuilt without the key, and both order reads apply it. The
 *      code is a payment credential, and the whole point of the dedicated route is that
 *      disclosure is a decision rather than a field.
 *
 *   5. **Idempotency is real.** The claim is atomic (`SET NX`), a replay returns the stored
 *      response byte-identical, a reused key is refused rather than answered, and a FAILURE
 *      releases the key so the caller may retry it.
 *
 *   6. **A `readonly` maintenance window leaves bot READS working.** This surface's reads
 *      are POSTs, so the `SAFE_METHODS` rule refuses all of them without its own branch —
 *      and a window meant to leave reads working would 503 "where is my order?".
 *
 * Run: npm run test:bot-surface
 */
import fs from 'fs';
import path from 'path';

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

/**
 * The async twin. Passing an `async` callback to `assert` is a silent always-pass — the
 * helper receives a Promise, which is truthy whatever it settles to.
 */
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

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake Redis is installed BEFORE the two stores are imported
// ─────────────────────────────────────────────────────────────────────────────
// Both stores reach for `getRedisClient` at CALL time rather than at import time, so
// patching the factory's export here is enough. Same monkey-patch-a-singleton technique
// `test:messaging-login` uses, for the same reason: a store driven against a fake with real
// `SET NX` semantics is an assertion, while a mocked store is a restatement of the code.
import * as redisFactory from '../../src/infra/redis/redis.factory';

interface FakeEntry { value: string; expiresAtMs: number | null }

class FakeRedis {
    readonly store = new Map<string, FakeEntry>();

    private live(key: string): FakeEntry | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }

    async get(key: string): Promise<string | null> {
        return this.live(key)?.value ?? null;
    }

    async set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null> {
        if (options?.NX && this.live(key)) return null;
        this.store.set(key, {
            value,
            expiresAtMs: options?.EX ? Date.now() + options.EX * 1000 : null,
        });
        return 'OK';
    }

    /** The only script either store evals is GET-then-DEL. */
    async eval(_script: string, options: { keys: string[] }): Promise<string | null> {
        const key = options.keys[0];
        const entry = this.live(key);
        if (!entry) return null;
        this.store.delete(key);
        return entry.value;
    }

    async del(key: string | string[]): Promise<number> {
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const k of keys) if (this.store.delete(k)) removed++;
        return removed;
    }

    keys(): string[] {
        return [...this.store.keys()];
    }

    ttlMs(key: string): number | null {
        const entry = this.store.get(key);
        if (!entry || entry.expiresAtMs === null) return null;
        return entry.expiresAtMs - Date.now();
    }
}

const fakeRedis = new FakeRedis();
 
(redisFactory as any).getRedisClient = async () => fakeRedis;

import {
    BOT_ROUTES,
    BOT_SURFACE_PREFIX,
    botRouteFor,
    isBotReadRequest,
    isBotSurfacePath,
} from '../../src/modules/bot-surface/domain/bot-route-table';
import {
    digestForKey,
    fingerprintRequest,
} from '../../src/modules/bot-surface/domain/bot-key-digest';
import {
    BotIdempotencyStore,
    BOT_IDEMPOTENCY_CLAIM_TTL_SECONDS,
    BOT_IDEMPOTENCY_RECORD_TTL_SECONDS,
} from '../../src/modules/bot-surface/services/bot-idempotency.store';
import {
    GeoCandidateStore,
    GEO_CANDIDATE_TTL_SECONDS,
} from '../../src/modules/bot-surface/services/geo-candidate.store';
import { BotIdentityService } from '../../src/modules/bot-surface/services/bot-identity.service';
import {
    stripDeliveryCodes,
    toBotAddressDto,
    toBotGeoCandidateDto,
    toBotIdentityDto,
    toBotProfileSummary,
    __maskingForTests,
} from '../../src/modules/bot-surface/dto/bot-projections';
import {
    BotEnvelopeSchema,
    BotCheckoutSchema,
    BotNotificationPreferencesSchema,
    BotReviewCreateSchema,
    BotTicketCreateSchema,
} from '../../src/modules/bot-surface/validators/bot.validators';
import { aggregatePaymentStatus } from '../../src/modules/bot-surface/controllers/bot-order.controller';
import { BOT_NOTIFY_SITUATIONS } from '../../src/modules/bot-surface/validators/bot.validators';
import {
    CUSTOMER_NOTIFICATION_TYPES,
    CustomerNotificationType,
} from '../../src/modules/notifications/models/customer-notification.model';
import { customerWhatsAppTemplateName } from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { evaluateMaintenance, MAINTENANCE_OFF } from '../../src/modules/system/domain/maintenance-mode';
import { projectDetails } from '../../src/core/error-detail-policy';
import { ERROR_CODES } from '../../src/core/error-codes';
import { AppError } from '../../src/core/errors';
import { GeoCandidate } from '../../src/core/geocoding';
import { renderBotReply, BotReplyIntent, __TG_LIMITS } from '../../src/modules/bot-surface/domain/channel-reply';
import {
    assertBotChromeCopyFits,
    botChrome,
    __CHROME_TABLE,
} from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    onboardingPromptFor,
    __SKIPPABLE_STEPS,
} from '../../src/modules/bot-surface/domain/bot-onboarding-copy';
import {
    skipActionId,
    __CALLBACK_DATA_BYTES,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import {
    SupportAgencyParty,
    SupportContextQuery,
    SupportContextService,
    SupportOrderFacts,
    SupportProductFacts,
    SupportStoreFacts,
} from '../../src/modules/bot-surface/services/support-context.service';

const SRC = path.join(__dirname, '..', '..', 'src');
const MODULE_DIR = path.join(SRC, 'modules', 'bot-surface');

function read(relativeToSrc: string): string {
    return fs.readFileSync(path.join(SRC, relativeToSrc), 'utf8');
}

/**
 * Every `.ts` under `src/`, for the reachability check only.
 *
 * The other scans deliberately look at the module alone — they are about what this surface's
 * own files may contain. Reachability is the opposite question and needs the whole tree, or a
 * file wired from `api/` or `lifecycle.ts` reads as an orphan.
 */
function allSourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(SRC);
    return out;
}

/** Every `.ts` under the module, so a scan cannot miss a file added later. */
function moduleFiles(): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) {
                out.push({ name: path.relative(MODULE_DIR, full), body: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(MODULE_DIR);
    return out;
}

/**
 * Comments stripped before a scan.
 *
 * ⚠ Every source scan here strips them first, and `test:connections` argues why at length:
 * this module's headers quote the very patterns they forbid — "no `req.auth`", "never
 * `issueTokenPair`" — and a scan that matched them would force those explanations out of
 * the codebase. A scan that makes the code worse is a scan worth fixing.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function main(): Promise<void> {
    console.log('\n═══ test:bot-surface ═══════════════════════════════════════════════════════\n');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The route table IS the contract copy — pinned to catalog.json');
    // ═════════════════════════════════════════════════════════════════════════

    const catalogPath = path.join(__dirname, '..', '..', 'api-doc', 'n8n', 'tools', 'catalog.json');
    interface CatalogTool {
        name: string;
        gap_ref?: string;
        surface: string;
        operation: { method: string; path: string };
        mutating: boolean;
        requires_customer_role: boolean;
    }
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { tools: CatalogTool[] };
    const gap001 = catalog.tools.filter((t) => t.gap_ref === 'GAP-001');

    assert('the catalogue still declares 42 GAP-001 tools', () => gap001.length === 42);

    /**
     * ⚠ This asserted "no more, no fewer" until 2026-08-25, and that was wrong the moment a
     * second gap landed on this surface.
     *
     * The table is GAP-001 **plus whatever else is mounted here later** — GAP-002's
     * registration routes, GAP-004's support composite. Demanding equality made this suite a
     * tripwire on the next feature rather than a check on this one: a red suite that means
     * "somebody is working" is a suite people stop reading.
     *
     * The invariant that actually matters, and survives: **every GAP-001 tool is still
     * mounted**, and **no row contradicts the catalogue**. A row the catalogue has not caught
     * up to is reported rather than failed — that is the ordinary state of in-flight work, and
     * the drift it could hide is caught by the agreement assertions below the moment the
     * catalogue gains the row.
     */
    assert('every GAP-001 tool is still mounted', () => {
        const declared = new Set(BOT_ROUTES.map((r) => r.tool));
        const missing = gap001.map((t) => t.name).filter((t) => !declared.has(t));
        if (missing.length) console.error('     ↳ missing:', missing.join(', '));
        return missing.length === 0;
    });

    assert('every mounted route the catalogue knows about is one it declares on this surface', () => {
        const known = new Map(catalog.tools.map((t) => [t.name, t]));
        const wrongSurface = BOT_ROUTES
            .filter((r) => known.has(r.tool))
            .filter((r) => known.get(r.tool)!.surface !== 'bot_internal')
            .map((r) => r.tool);
        const uncatalogued = BOT_ROUTES.filter((r) => !known.has(r.tool)).map((r) => r.tool);
        // Not a failure: a route ahead of its catalogue row is what in-flight work looks like.
        if (uncatalogued.length) {
            console.log('     ↳ note: not yet in the catalogue —', uncatalogued.join(', '));
        }
        if (wrongSurface.length) console.error('     ↳ wrong surface:', wrongSurface.join(', '));
        return wrongSurface.length === 0;
    });

    /**
     * ⚠ **The three agreement assertions below cover EVERY mounted row the catalogue knows
     * about, not only GAP-001's.** They iterated `gap001` until GAP-004, which meant the two
     * GAP-002 rows and the support composite were mounted, catalogued, and pinned by
     * nothing — a `mutating` flag drifting there would have been exactly as invisible as
     * the drift this suite exists to catch, on rows added *after* the suite was written.
     *
     * `gap001` keeps its own two assertions above (the count, and that all 42 are still
     * mounted); what generalises is the agreement, which is a property of any row that is
     * in both places.
     */
    const mountedTools = new Set(BOT_ROUTES.map((r) => r.tool));
    const catalogued = catalog.tools.filter((t) => mountedTools.has(t.name));

    assert('a MOUNTED route is never still marked `status: "gap"` in the catalogue', () => {
        // The catalogue's own notes promise that a `gap` tool "does NOT exist". A row that
        // is mounted and still says so tells the automation layer not to call something it
        // could call — the failure that leaves a shipped feature unreachable.
        const stale = catalogued
            .filter((t) => (t as { status?: string }).status === 'gap')
            .map((t) => t.name);
        if (stale.length) console.error('     ↳ mounted but catalogued as a gap:', stale.join(', '));
        return stale.length === 0;
    });

    assert('every route agrees with the catalogue on METHOD and PATH', () => {
        const bad: string[] = [];
        for (const tool of catalogued) {
            const route = BOT_ROUTES.find((r) => r.tool === tool.name);
            if (!route) continue;
            // The catalogue writes `{param}`; Express writes `:param`. One notation, two
            // spellings — normalised rather than duplicated in the table.
            const expectedPath = tool.operation.path
                .replace(`${BOT_SURFACE_PREFIX}`, '')
                .replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
            if (route.method !== tool.operation.method) bad.push(`${tool.name}: method`);
            if (route.path !== expectedPath) bad.push(`${tool.name}: ${route.path} ≠ ${expectedPath}`);
        }
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('every route agrees with the catalogue on `mutating`', () => {
        const bad = catalogued
            .filter((tool) => BOT_ROUTES.find((r) => r.tool === tool.name)?.mutating !== tool.mutating)
            .map((t) => t.name);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('every route agrees with the catalogue on `requires_customer_role`', () => {
        const bad = catalogued
            .filter((tool) => BOT_ROUTES.find((r) => r.tool === tool.name)?.requiresCustomerRole !== tool.requires_customer_role)
            .map((t) => t.name);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    /**
     * ⚠ **Every route that touches a customer's own data requires the customer role**, and
     * the exemptions live in ONE namespace.
     *
     * This used to name `identity_resolve_sender` as the single exemption, which stopped being
     * true when GAP-002 added registration. The property worth pinning was never "there is
     * exactly one" — it is that an exemption cannot appear on a cart, an order, an address or
     * a payment. A row under `/identity/` answers questions *about the sender*; every other
     * row acts *for* them, and on those an unresolved caller is precisely the request that
     * must not run.
     */
    assert('no route outside /identity/ may run without a customer role', () => {
        const loose = BOT_ROUTES
            .filter((r) => !r.requiresCustomerRole)
            .filter((r) => !r.path.startsWith('/identity/'))
            .map((r) => `${r.tool} (${r.path})`);
        if (loose.length) console.error('     ↳ customer data reachable unresolved:', loose.join(', '));
        return loose.length === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · Route matching, and the shadowing guard that runs at import');
    // ═════════════════════════════════════════════════════════════════════════

    assert('a literal beats a parameter — /orders/list is not read as an order id', () =>
        botRouteFor('POST', '/api/internal/bot/orders/list')?.tool === 'orders_list_groups');

    assert('an id still reaches the parameterised route', () =>
        botRouteFor('POST', '/api/internal/bot/orders/68f0000000000000000000aa')?.tool === 'orders_get_order');

    assert('/tickets/list is not read as a ticket id', () =>
        botRouteFor('POST', '/api/internal/bot/tickets/list')?.tool === 'tickets_list');

    assert('/bookings/list is not read as a booking id', () =>
        botRouteFor('POST', '/api/internal/bot/bookings/list')?.tool === 'bookings_list');

    assert('/orders/groups/:cartId is not read as /orders/:orderId/shipments', () =>
        botRouteFor('POST', '/api/internal/bot/orders/groups/cart-1')?.tool === 'orders_get_group');

    assert('method is part of the match — POST and PATCH on one path are two routes', () =>
        botRouteFor('POST', '/api/internal/bot/notifications/preferences')?.tool === 'notifications_get_preferences'
        && botRouteFor('PATCH', '/api/internal/bot/notifications/preferences')?.tool === 'notifications_update_preferences');

    assert('a parameter matches ONE segment, never a slash', () =>
        botRouteFor('POST', '/api/internal/bot/payments/a/b') === null);

    assert('an unknown path under the prefix resolves to nothing', () =>
        botRouteFor('POST', '/api/internal/bot/nope') === null);

    assert('the prefix test is anchored on a segment boundary', () =>
        isBotSurfacePath('/api/internal/bot/cart/get')
        && isBotSurfacePath('/api/internal/bot')
        && !isBotSurfacePath('/api/internal/bot-lookalike/cart'));

    /**
     * The shadow guard must RUN, not merely exist.
     *
     * A `assertNoShadowedRoutes` that is exported and never called is exactly the state this
     * service has found guards in before — `requireActiveUser` and `requireLegitBusiness` both
     * had zero call sites, and one of them would have denied every vendor. The behavioural
     * half is the matching assertions above; this is the half that says the process refuses to
     * boot rather than discovering an unreachable route at request time.
     */
    assert('both import-time guards are INVOKED, not merely exported', () => {
        const table = stripComments(read('modules/bot-surface/domain/bot-route-table.ts'));
        return /^assertToolNamesUnique\(\);$/m.test(table)
            && /^assertNoShadowedRoutes\(\);$/m.test(table);
    });

    assert('the handler registry is closed in BOTH directions, and checked at import', () => {
        const routes = stripComments(read('modules/bot-surface/bot.routes.ts'));
        return routes.includes('no handler for')
            && routes.includes('handler with no route')
            && /^assertHandlersCoverRoutes\(\);$/m.test(routes);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · Maintenance — blocked in `down`, reads survive `readonly`');
    // ═════════════════════════════════════════════════════════════════════════

    const now = new Date();
    const stateOf = (mode: 'readonly' | 'down') => ({ ...MAINTENANCE_OFF, mode });

    assert('`down` blocks a bot READ', () =>
        !evaluateMaintenance(stateOf('down'), now, 'POST', '/api/internal/bot/cart/get').allowed);

    assert('`down` blocks a bot WRITE', () =>
        !evaluateMaintenance(stateOf('down'), now, 'POST', '/api/internal/bot/checkout').allowed);

    assert('`readonly` ALLOWS a bot read — the branch this rule exists for', () =>
        evaluateMaintenance(stateOf('readonly'), now, 'POST', '/api/internal/bot/orders/list').allowed);

    assert('`readonly` blocks a bot write', () =>
        !evaluateMaintenance(stateOf('readonly'), now, 'POST', '/api/internal/bot/checkout').allowed);

    assert('`readonly` blocks a bot DELETE and a bot PATCH', () =>
        !evaluateMaintenance(stateOf('readonly'), now, 'DELETE', '/api/internal/bot/cart').allowed
        && !evaluateMaintenance(stateOf('readonly'), now, 'PATCH', '/api/internal/bot/profile/language').allowed);

    assert('an unrecognised bot path fails CLOSED in `readonly`', () =>
        !evaluateMaintenance(stateOf('readonly'), now, 'POST', '/api/internal/bot/not-a-route').allowed);

    assert('`off` allows everything, as everywhere else', () =>
        evaluateMaintenance(MAINTENANCE_OFF, now, 'POST', '/api/internal/bot/checkout').allowed);

    assert('the bot surface is NOT on the always-exempt list', () => {
        const source = stripComments(read('modules/system/domain/maintenance-mode.ts'));
        const exemptBlock = source.slice(
            source.indexOf('ALWAYS_EXEMPT'),
            source.indexOf('const WEBHOOK_PREFIX'),
        );
        return !exemptBlock.includes('/api/internal/bot');
    });

    assert('the sibling internal surfaces ARE still exempt — this change touched nothing else', () =>
        evaluateMaintenance(stateOf('down'), now, 'GET', '/api/internal/agents/x/tracking-policy').allowed
        && evaluateMaintenance(stateOf('down'), now, 'GET', '/api/internal/shipments/x/destination').allowed
        && evaluateMaintenance(stateOf('down'), now, 'GET', '/api/tracking/visible-agents').allowed
        && evaluateMaintenance(stateOf('down'), now, 'GET', '/api/internal/admin/system/maintenance').allowed);

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The identity refusal table');
    // ═════════════════════════════════════════════════════════════════════════

    const account = {
        userId: 'u1',
        customerId: 'c1',
        channel: 'whatsapp' as const,
        externalIdentity: '237600123456',
        identityHint: '••••3456',
    };

    /** A resolver stub returning one fixed outcome. */
    const serviceReturning = (resolution: unknown) =>
         
        new BotIdentityService({ resolveForLogin: async () => resolution } as any);

    const refusalOf = async (resolution: unknown): Promise<AppError | null> => {
        try {
            await serviceReturning(resolution).resolve({ channel: 'whatsapp', externalId: '237600123456' });
            return null;
        } catch (err) {
            return err as AppError;
        }
    };

    await assertAsync('a resolved sender comes back with BOTH ids', async () => {
        const resolved = await serviceReturning({ status: 'resolved', account })
            .resolve({ channel: 'whatsapp', externalId: '237600123456' });
        return resolved.userId === 'u1' && resolved.customerId === 'c1';
    });

    await assertAsync('needs_contact → 409 BOT_IDENTITY_NEEDS_CONTACT, state anonymous', async () => {
        const e = await refusalOf({ status: 'needs_contact' });
        return e?.code === ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT
            && e.statusCode === 409
            && e.details?.state === 'anonymous';
    });

    await assertAsync('no_account → 404 BOT_IDENTITY_UNRESOLVED, state anonymous', async () => {
        const e = await refusalOf({ status: 'no_account' });
        return e?.code === ERROR_CODES.BOT_IDENTITY_UNRESOLVED
            && e.statusCode === 404
            && e.details?.state === 'anonymous'
            && e.details?.reason === 'no_account';
    });

    await assertAsync('not_customer → 403 BOT_IDENTITY_NOT_CUSTOMER', async () => {
        const e = await refusalOf({ status: 'not_customer' });
        return e?.code === ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER
            && e.statusCode === 403
            && e.details?.state === 'non_customer';
    });

    await assertAsync('account_inactive → the PLATFORM-WIDE suspension code, not a BOT_* alias', async () => {
        const e = await refusalOf({ status: 'account_inactive' });
        return e?.code === ERROR_CODES.AUTH_ACCOUNT_SUSPENDED && e.statusCode === 403;
    });

    await assertAsync('identity_taken does NOT get a code of its own — it must not name the other account', async () => {
        const e = await refusalOf({ status: 'identity_taken' });
        return e?.code === ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER
            && e.details?.reason === 'identity_taken';
    });

    await assertAsync('a refusal NEVER carries the messaging identity', async () => {
        for (const status of ['needs_contact', 'no_account', 'not_customer', 'account_inactive', 'identity_taken']) {
            const e = await refusalOf({ status });
            if (JSON.stringify(e?.details ?? {}).includes('237600123456')) return false;
            if ((e?.message ?? '').includes('237600123456')) return false;
        }
        return true;
    });

    /**
     * ⚠ What the SERVICE writes is not what the CLIENT sees, and both halves matter.
     *
     * Phase 16 filters `details` at the boundary, keyed on category. The catalogue promises
     * `state` on `BOT_IDENTITY_UNRESOLVED`, and the registration flow (GAP-002) reads it —
     * so the `not_found` and `conflict` refusals must carry it through. The two 403s must
     * NOT: `AUTHORIZATION_DETAIL_KEYS` admits four keys and none of them is `state`, because
     * an authorization failure that echoes facts about the caller is the leak that allowlist
     * was written to close.
     *
     * Pinned in both directions so nobody widens the allowlist to make a bot flow simpler.
     */
    await assertAsync('⚠ `state` survives the boundary on the 404 and the 409 — the flow reads it', async () => {
        for (const status of ['no_account', 'needs_contact']) {
            const e = await refusalOf({ status });
            const projected = projectDetails(e!.category, e!.details);
            if (projected?.state === undefined) return false;
        }
        return true;
    });

    await assertAsync('⚠ …and is DROPPED on BOT_IDENTITY_NOT_CUSTOMER — the code is the whole signal', async () => {
        for (const status of ['not_customer', 'identity_taken']) {
            const e = await refusalOf({ status });
            if (projectDetails(e!.category, e!.details) !== undefined) return false;
        }
        return true;
    });

    /**
     * ⚠ The suspended refusal is the exception, and it is the ERROR SYSTEM's exception rather
     * than this module's. `AUTH_ACCOUNT_SUSPENDED` is a 403 on the wire but carries a category
     * OVERRIDE to `authentication` — "the account cannot authenticate at all, not a
     * per-resource denial" — and `authentication` details pass through the scrubber rather
     * than the authorization allowlist. So `state` survives here and not on the code beside it.
     *
     * Pinned because it looks like an inconsistency and is not: a client reading `state` gets
     * it on three of the four refusals, and the fourth is precisely the one where the code
     * already says everything.
     */
    await assertAsync('the SUSPENDED refusal keeps its state — an authentication override, not authorization', async () => {
        const e = await refusalOf({ status: 'account_inactive' });
        return projectDetails(e!.category, e!.details)?.state === 'non_customer';
    });

    await assertAsync('the intent passed down is `login`, which is what gates on the customer role', async () => {
        let seen: unknown = null;
         
        const service = new BotIdentityService({
            resolveForLogin: async (channel: string, externalId: string, profile: unknown) => {
                seen = { channel, externalId, profile };
                return { status: 'resolved', account };
            },
             
        } as any);
        await service.resolve({ channel: 'telegram', externalId: '99', displayName: 'Ada', handle: '@ada' });
        // `resolveForLogin` is the only entry point called; `resolveForReset` would gate
        // differently and would hand a chat a reset credential nobody asked for.
        return JSON.stringify(seen) === JSON.stringify({
            channel: 'telegram',
            externalId: '99',
            profile: { displayName: 'Ada', handle: '@ada' },
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · Idempotency, against a fake Redis with real SET NX semantics');
    // ═════════════════════════════════════════════════════════════════════════

    const store = new BotIdempotencyStore();
    const idem = { identity: 'u1:whatsapp', key: 'k-1', fingerprint: 'fp-a', tool: 'checkout_create_orders' };

    await assertAsync('a first claim succeeds', async () =>
        (await store.claim(idem)).status === 'claimed');

    await assertAsync('a concurrent second claim is IN PROGRESS, not a second execution', async () =>
        (await store.claim(idem)).status === 'in_progress');

    await assertAsync('the claim TTL is short, so a crash costs a minute rather than a day', async () => {
        const key = fakeRedis.keys().find((k) => k.startsWith('bot:idem:'));
        if (!key) return false;
        const ttl = fakeRedis.ttlMs(key);
        return ttl !== null && ttl <= BOT_IDEMPOTENCY_CLAIM_TTL_SECONDS * 1000 + 50;
    });

    await assertAsync('a completed call is REPLAYED byte-identically', async () => {
        await store.complete({ ...idem, response: { status: 201, body: { success: true, data: { cartId: 'x' } } } });
        const claim = await store.claim(idem);
        return claim.status === 'replay'
            && claim.response.status === 201
            && JSON.stringify(claim.response.body) === JSON.stringify({ success: true, data: { cartId: 'x' } });
    });

    await assertAsync('completion extends the record to its full 24 hours', async () => {
        const key = fakeRedis.keys().find((k) => k.startsWith('bot:idem:'));
        if (!key) return false;
        const ttl = fakeRedis.ttlMs(key);
        return ttl !== null && ttl > BOT_IDEMPOTENCY_CLAIM_TTL_SECONDS * 1000
            && ttl <= BOT_IDEMPOTENCY_RECORD_TTL_SECONDS * 1000 + 50;
    });

    await assertAsync('the SAME key with a DIFFERENT request is refused, never answered', async () => {
        const claim = await store.claim({ ...idem, fingerprint: 'fp-b', tool: 'cart_add_item' });
        return claim.status === 'reused' && claim.tool === 'checkout_create_orders';
    });

    await assertAsync('a released key may be retried', async () => {
        await store.release(idem.identity, idem.key);
        return (await store.claim(idem)).status === 'claimed';
    });

    await assertAsync('records are scoped to the IDENTITY — one customer never replays another\'s', async () => {
        await store.complete({ ...idem, response: { status: 200, body: { mine: true } } });
        const other = await store.claim({ ...idem, identity: 'u2:whatsapp' });
        return other.status === 'claimed';
    });

    assert('the raw identity and the raw key are HASHED into the key name', () => {
        const keys = fakeRedis.keys().filter((k) => k.startsWith('bot:idem:'));
        return keys.length > 0
            && keys.every((k) => !k.includes('u1:whatsapp') && !k.includes('k-1'))
            && keys.some((k) => k.includes(digestForKey('u1:whatsapp')));
    });

    assert('a fingerprint is stable under key ORDER — a retry must not read as a new request', () =>
        fingerprintRequest('POST', '/x', { b: 2, a: 1, c: { z: 1, y: 2 } })
        === fingerprintRequest('POST', '/x', { a: 1, c: { y: 2, z: 1 }, b: 2 }));

    assert('an omitted key and an explicit `undefined` fingerprint the same', () =>
        fingerprintRequest('POST', '/x', { a: 1 })
        === fingerprintRequest('POST', '/x', { a: 1, b: undefined }));

    assert('a different ARGUMENT changes the fingerprint', () =>
        fingerprintRequest('POST', '/x', { a: 1 }) !== fingerprintRequest('POST', '/x', { a: 2 }));

    assert('a different PATH changes the fingerprint — one key cannot serve two routes', () =>
        fingerprintRequest('POST', '/x', { a: 1 }) !== fingerprintRequest('POST', '/y', { a: 1 }));

    /**
     * The classification IS the coverage — the middleware reads this table — so what is worth
     * asserting is that the rows whose answer matters are classified the way they must be, not
     * how many there are. (A count was here and went with the "no more, no fewer" assumption
     * above: a magic number that has to be edited whenever a route lands is a number somebody
     * edits without reading.)
     */
    assert('the rows whose classification carries a consequence are right', () => {
        const mutating = new Set(BOT_ROUTES.filter((r) => r.mutating).map((r) => r.tool));
        return mutating.has('checkout_create_orders')      // a retry = a second set of orders
            && mutating.has('cart_add_item')               // a retry = a doubled line
            && !mutating.has('orders_get_cod_code')        // discloses a credential, changes nothing
            && !isBotReadRequest('POST', '/api/internal/bot/checkout')
            && isBotReadRequest('POST', '/api/internal/bot/cart/get');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · Geo candidate handles (GAP-005)');
    // ═════════════════════════════════════════════════════════════════════════

    const geoStore = new GeoCandidateStore();
    const candidate: GeoCandidate = {
        formatted_address: 'Rue Njo-Njo, Bonapriso, Douala, Cameroon',
        coordinates: { type: 'Point', coordinates: [9.7043, 4.0383] },
        provider: 'locationiq',
        provider_place_id: 'osm:way:123',
        components: {
            street: 'Rue Njo-Njo',
            neighbourhood: 'Bonapriso',
            city: 'Douala',
            region: 'Littoral',
            country: 'Cameroon',
            country_code: 'CM',
            postal_code: null,
        },
    };

    let refs: string[] = [];

    await assertAsync('a handle is minted per candidate, in ranking order', async () => {
        refs = await geoStore.mint('u1', [candidate, { ...candidate, formatted_address: 'second' }], 'njo njo');
        return refs.length === 2 && refs.every((r) => r.startsWith('gc_')) && refs[0] !== refs[1];
    });

    assert('the handle carries no coordinate and no address', () =>
        refs.every((r) => !r.includes('9.7') && !r.includes('Douala')));

    assert('the handle is HASHED into the Redis key name', () => {
        const keys = fakeRedis.keys().filter((k) => k.startsWith('bot:geo:'));
        return keys.length >= 2 && keys.every((k) => !refs.some((r) => k.includes(r)));
    });

    assert('the TTL is the flow window, not a day', () => {
        const key = fakeRedis.keys().find((k) => k.startsWith('bot:geo:'));
        const ttl = key ? fakeRedis.ttlMs(key) : null;
        return ttl !== null && ttl > 0 && ttl <= GEO_CANDIDATE_TTL_SECONDS * 1000 + 50;
    });

    await assertAsync('consuming returns the WHOLE candidate, coordinates included', async () => {
        const stored = await geoStore.consume('u1', refs[0]);
        return stored?.candidate.coordinates.coordinates[0] === 9.7043
            && stored.rawInput === 'njo njo';
    });

    await assertAsync('a handle is SINGLE-USE — a retry cannot save the address twice', async () =>
        (await geoStore.consume('u1', refs[0])) === null);

    await assertAsync('another account cannot spend it', async () =>
        (await geoStore.consume('u2', refs[1])) === null);

    await assertAsync('a wrong-owner attempt still SPENDS it — never a probe', async () =>
        (await geoStore.consume('u1', refs[1])) === null);

    await assertAsync('a value that is not one of ours costs no round trip', async () =>
        (await geoStore.consume('u1', 'not-a-handle')) === null);

    await assertAsync('minting nothing writes nothing', async () =>
        (await geoStore.mint('u1', [], null)).length === 0);

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · The four projections that differ from the customer API');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the identity DTO carries the HINT and never the identity', () => {
        const dto = toBotIdentityDto({
            displayName: 'Ada',
            language: 'fr',
            connectedChannels: ['whatsapp'],
            hasOpenOrders: true,
            identityHint: '••••3456',
        });
        const json = JSON.stringify(dto);
        return !json.includes('externalId') && !json.includes('237600123456') && dto.identityHint === '••••3456';
    });

    assert('the profile MASKS the email and the phone, and drops the address array', () => {
         
        const summary = toBotProfileSummary({
            id: 'c1',
            name: 'Ada Lovelace',
            email: 'ada.lovelace@example.com',
            emailVerified: true,
            phone: '+237600124417',
            phoneVerified: true,
            avatar: null,
            bio: 'secret bio',
            savedAddresses: [{}, {}],
            dateOfBirth: new Date('1990-01-01'),
            preferences: { language: 'fr', currency: 'XAF', marketing_opt_in: false, ai_tone: [], ads_compact_mode: false, compact_mode: false },
            recentProductCode: 'SKU-1',
            savedPaymentMethods: [{ id: 'pm1', provider: 'x', display_label: 'Visa ••1234', method_type: 'card', is_default: true }],
            timezone: 'Africa/Douala',
            status: 'active',
            onboardingStep: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
             
        } as any);
        const json = JSON.stringify(summary);
        return summary.savedAddressCount === 2
            && !json.includes('ada.lovelace@example.com')
            && !json.includes('+237600124417')
            && !json.includes('secret bio')
            && !json.includes('Visa')
            && !json.includes('savedAddresses');
    });

    assert('the masking shapes match the credential-delivery pair EXACTLY', () => {
        // Pinned rather than trusted: a customer must not meet their own address masked two
        // different ways depending on which surface answered. The comparands are lifted from
        // that file's own doc comments.
        return __maskingForTests.maskEmail('jean.dupont@example.com') === 'j••••t@example.com'
            && __maskingForTests.maskPhone('+237600124417') === '+2376••••4417';
    });

    assert('an address reports `deliverable` and omits raw coordinates', () => {
         
        const withGeo = toBotAddressDto({
            _id: { toString: () => 'a1' },
            label: 'Home',
            address_line1: 'typed line',
            address_line2: 'blue gate',
            city: 'Douala',
            state: 'Littoral',
            country: 'CM',
            is_default: true,
            geo: { formatted_address: 'Rue Njo-Njo, Douala', coordinates: { type: 'Point', coordinates: [9.7, 4.0] } },
             
        } as any);
        const json = JSON.stringify(withGeo);
        return withGeo.deliverable === true
            && withGeo.formattedAddress === 'Rue Njo-Njo, Douala'
            && !json.includes('9.7')
            && !json.includes('coordinates');
    });

    assert('an ungeocoded address is `deliverable: false` and still renders', () => {
         
        const legacy = toBotAddressDto({
            _id: { toString: () => 'a2' },
            label: 'Old',
            address_line1: 'Rue de la Joie',
            address_line2: null,
            city: 'Yaoundé',
            state: null,
            country: 'CM',
            is_default: false,
            geo: null,
             
        } as any);
        return legacy.deliverable === false && legacy.formattedAddress === 'Rue de la Joie';
    });

    assert('a geo candidate answers with a handle and no pin', () => {
        const dto = toBotGeoCandidateDto('gc_abc', candidate);
        const json = JSON.stringify(dto);
        return dto.candidateRef === 'gc_abc'
            && !json.includes('9.7043')
            && !json.includes('osm:way:123')
            && dto.components.city === 'Douala';
    });

    assert('the COD delivery code is stripped and everything else survives', () => {
        const order = {
            id: 'o1',
            codCollections: [
                { shipmentId: 's1', expectedAmount: 12000, currency: 'XAF', status: 'pending', deliveryCode: '482913' },
                { shipmentId: 's2', expectedAmount: 3000, currency: 'XAF', status: 'collected' },
            ],
        };
        const stripped = stripDeliveryCodes(order);
        const json = JSON.stringify(stripped);
        return !json.includes('482913')
            && !json.includes('deliveryCode')
            && json.includes('12000')
            && json.includes('s2');
    });

    assert('an order with no COD block is returned unchanged, not rebuilt', () => {
        const order: { id: string; codCollections?: unknown[] } = { id: 'o1' };
        return stripDeliveryCodes(order) === order;
    });

    assert('the group aggregate agrees with the customer controller, over the whole table', () => {
        const cases: Array<[string[], string]> = [
            [[], 'unknown'],
            [['refunded', 'refunded'], 'refunded'],
            [['failed'], 'failed'],
            [['paid', 'disputed'], 'disputed'],
            [['paid', 'paid'], 'paid'],
            [['paid', 'pending'], 'partially_paid'],
            [['pending', 'AWAITING_PAYMENT'], 'awaiting_payment'],
            [['refunded', 'pending'], 'mixed'],
        ];
        return cases.every(([input, expected]) => aggregatePaymentStatus(input) === expected);
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('8 · Validators — the door refuses what it cannot serve');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the envelope is required and strict', () =>
        BotEnvelopeSchema.safeParse({}).success === false
        && BotEnvelopeSchema.safeParse({ identity: { channel: 'whatsapp', externalId: '237600123456' } }).success === true);

    assert('⚠ a caller-supplied customerId is a 400, not a stripped field', () =>
        BotEnvelopeSchema.safeParse({
            identity: { channel: 'whatsapp', externalId: '237600123456', customerId: 'c-someone-else' },
        }).success === false);

    assert('⚠ a caller-supplied userId or token is refused the same way', () =>
        BotEnvelopeSchema.safeParse({ identity: { channel: 'whatsapp', externalId: '1', userId: 'u2' } }).success === false
        && BotEnvelopeSchema.safeParse({ identity: { channel: 'whatsapp', externalId: '1', token: 'x' } }).success === false);

    assert('an unknown channel is refused', () =>
        BotEnvelopeSchema.safeParse({ identity: { channel: 'sms', externalId: '1' } }).success === false);

    assert('checkout REQUIRES an explicit address and payment method', () =>
        BotCheckoutSchema.safeParse({ paymentMethod: 'online' }).success === false
        && BotCheckoutSchema.safeParse({ deliveryAddressId: '68f0000000000000000000aa' }).success === false
        && BotCheckoutSchema.safeParse({ paymentMethod: 'online', deliveryAddressId: '68f0000000000000000000aa' }).success === true);

    assert('a ticket type is case-folded to the platform enum', () => {
        const parsed = BotTicketCreateSchema.safeParse({
            subject: 's', description: 'd', type: 'order_issue',
        });
        return parsed.success && parsed.data.type === 'ORDER_ISSUE';
    });

    assert('a ticket description over the model ceiling is a 400, not a 500 on the model', () =>
        BotTicketCreateSchema.safeParse({ subject: 's', description: 'x'.repeat(701), type: 'ORDER_ISSUE' }).success === false);

    assert('entityType without entityId is refused', () =>
        BotTicketCreateSchema.safeParse({ subject: 's', description: 'd', type: 'ORDER_ISSUE', entityType: 'ORDER' }).success === false);

    assert('a review takes no `title` — a chat writes one block of prose', () =>
        BotReviewCreateSchema.safeParse({
            subjectType: 'product', subjectId: '68f0000000000000000000aa', rating: 5, title: 'Great',
        }).success === false);

    assert('notification preferences take ONE channel, not three booleans', () =>
        BotNotificationPreferencesSchema.safeParse({ channel: 'email' }).success === true
        && BotNotificationPreferencesSchema.safeParse({ emailEnabled: true }).success === false);

    assert('⚠ money and cancellation notifications carry no preference key', () => {
        const shape = Object.keys(BotNotificationPreferencesSchema.shape);
        return !shape.some((k) => /payment|refund|balance|cancel/i.test(k));
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · The support-routing ladder (GAP-004)');
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * The one piece of genuine POLICY on this surface, and the reason it is tested here
     * rather than only live: GAP-004 exists to move this ladder out of n8n, so the ladder
     * itself is the deliverable. Every fact it reads comes from a port, so the whole of it
     * runs with no database.
     */
    const ORDER: SupportOrderFacts = { id: 'o-1', orderNumber: 'ORD-2026-000123', vendorId: 'v-1' };
    const OTHER_ORDER: SupportOrderFacts = { id: 'o-2', orderNumber: 'ORD-2026-000999', vendorId: 'v-1' };
    const STORE: SupportStoreFacts = {
        slug: 'maison-bella',
        name: 'Maison Bella',
        supportEmail: 'hello@maisonbella.cm',
        supportPhone: null,
        supportWhatsapp: '+237600000001',
    };
    const AGENCY: SupportAgencyParty = {
        id: 'ag-1',
        name: 'Douala Express',
        supportWhatsapp: null,
        supportPhone: '+237600000002',
        supportEmail: null,
    };
    const PRODUCT_ID = '68f0000000000000000000aa';
    const CODED_ID = '68f0000000000000000000bb';
    const PRODUCT: SupportProductFacts = {
        id: PRODUCT_ID,
        title: 'Ankara Wax Print Maxi Dress',
        storeSlug: 'maison-bella',
    };

    interface SupportWorld {
        owned?: SupportOrderFacts | null;
        recentOrder?: SupportOrderFacts | null;
        store?: SupportStoreFacts | null;
        agency?: SupportAgencyParty | null;
        products?: Record<string, SupportProductFacts>;
        viewed?: string | null;
        code?: string | null;
    }

    const supportOf = (world: SupportWorld = {}): SupportContextService =>
        new SupportContextService(
            {
                findOwned: async () => world.owned ?? null,
                findMostRecent: async () => world.recentOrder ?? null,
            },
            {
                findByVendorId: async () => world.store ?? null,
                findBySlug: async () => world.store ?? null,
            },
            { findForOrder: async () => world.agency ?? null },
            { find: async (id) => world.products?.[id] ?? null },
            {
                mostRecentlyViewedProductId: async () => world.viewed ?? null,
                recentProductCode: async () => world.code ?? null,
            },
        );

    const supportErrorOf = async (
        world: SupportWorld,
        query: SupportContextQuery,
    ): Promise<AppError | null> => {
        try {
            await supportOf(world).resolve('c1', query);
            return null;
        } catch (err) {
            return err as AppError;
        }
    };

    await assertAsync('rung 1 · an order hint resolves both parties and names the subject', async () => {
        const ctx = await supportOf({ owned: ORDER, store: STORE, agency: AGENCY })
            .resolve('c1', { scope: 'auto', hintOrderId: 'ORD-2026-000123' });
        return ctx.resolvedFrom === 'hint_order'
            && ctx.subject.type === 'order'
            && ctx.subject.label === 'ORD-2026-000123 — Maison Bella'
            && ctx.vendor?.storeSlug === 'maison-bella'
            && ctx.agency?.name === 'Douala Express';
    });

    await assertAsync('⚠ an order hint WINS over a product hint sent in the same call', async () => {
        const ctx = await supportOf({ owned: ORDER, store: STORE, products: { [PRODUCT_ID]: PRODUCT } })
            .resolve('c1', { scope: 'auto', hintOrderId: 'o-1', hintProductId: PRODUCT_ID });
        return ctx.resolvedFrom === 'hint_order' && ctx.subject.type === 'order';
    });

    await assertAsync('⚠ an order hint that is not theirs is REFUSED, never fallen through', async () => {
        // Falling through would answer confidently about their OTHER purchase, which is the
        // failure `must_echo` exists to prevent — the reply names a subject either way.
        const e = await supportErrorOf(
            { owned: null, recentOrder: OTHER_ORDER, store: STORE },
            { scope: 'auto', hintOrderId: 'ORD-NOPE' },
        );
        return e?.code === ERROR_CODES.ORDER_NOT_FOUND && e.statusCode === 404;
    });

    await assertAsync('⚠ a product hint that does not resolve is refused the same way', async () => {
        const e = await supportErrorOf(
            { products: {}, recentOrder: OTHER_ORDER, store: STORE },
            { scope: 'auto', hintProductId: PRODUCT_ID },
        );
        return e?.code === ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND && e.statusCode === 404;
    });

    await assertAsync('rung 3 · with no hint, the most recent order answers', async () => {
        const ctx = await supportOf({ recentOrder: ORDER, store: STORE, agency: AGENCY })
            .resolve('c1', { scope: 'auto' });
        return ctx.resolvedFrom === 'recent_order' && ctx.agency?.id === 'ag-1';
    });

    await assertAsync('rung 4 · no orders → the most recently viewed product, and NO agency', async () => {
        const ctx = await supportOf({ viewed: PRODUCT_ID, products: { [PRODUCT_ID]: PRODUCT }, store: STORE })
            .resolve('c1', { scope: 'auto' });
        return ctx.resolvedFrom === 'recently_viewed'
            && ctx.subject.label === 'Ankara Wax Print Maxi Dress'
            && ctx.vendor?.name === 'Maison Bella'
            && ctx.agency === null;
    });

    await assertAsync('a viewed product that is no longer publishable SKIPS to the next rung', async () => {
        // The recently-viewed list deliberately outlives the products in it.
        const ctx = await supportOf({
            viewed: PRODUCT_ID,
            code: CODED_ID,
            products: { [CODED_ID]: { ...PRODUCT, id: CODED_ID, title: 'Kente Tote' } },
            store: STORE,
        }).resolve('c1', { scope: 'auto' });
        return ctx.resolvedFrom === 'recent_product_code' && ctx.subject.label === 'Kente Tote';
    });

    await assertAsync('⚠ a junk `recentProductCode` never errors — it drops to the platform rung', async () => {
        // The field is client-writable through PATCH /api/customer/profile and has no
        // guaranteed vocabulary; a value somebody set years ago is not a request.
        const ctx = await supportOf({ code: 'whatever-the-client-put-here' }).resolve('c1', { scope: 'auto' });
        return ctx.resolvedFrom === 'none' && ctx.subject.type === 'none' && ctx.subject.label === null;
    });

    await assertAsync('rung 6 · nothing at all, scope auto → 200 with the platform alone', async () => {
        const ctx = await supportOf().resolve('c1', { scope: 'auto' });
        return ctx.resolvedFrom === 'none'
            && ctx.vendor === null
            && ctx.agency === null
            && ctx.platform.canOpenTicket === true;
    });

    await assertAsync('an order with no shipments yet answers with the seller and no agency', async () => {
        const ctx = await supportOf({ recentOrder: ORDER, store: STORE, agency: null })
            .resolve('c1', { scope: 'auto' });
        return ctx.vendor !== null && ctx.agency === null;
    });

    await assertAsync('an order whose store is missing still names the order number alone', async () => {
        const ctx = await supportOf({ recentOrder: ORDER, store: null }).resolve('c1', { scope: 'auto' });
        return ctx.subject.label === 'ORD-2026-000123' && ctx.vendor === null;
    });

    await assertAsync('scope vendor narrows to the seller and keeps the platform', async () => {
        const ctx = await supportOf({ recentOrder: ORDER, store: STORE, agency: AGENCY })
            .resolve('c1', { scope: 'vendor' });
        return ctx.vendor !== null && ctx.agency === null && ctx.platform.canOpenTicket === true;
    });

    await assertAsync('scope agency narrows to the delivery company and keeps the platform', async () => {
        const ctx = await supportOf({ recentOrder: ORDER, store: STORE, agency: AGENCY })
            .resolve('c1', { scope: 'agency' });
        return ctx.agency !== null && ctx.vendor === null && ctx.platform.canOpenTicket === true;
    });

    await assertAsync('scope platform drops both trading parties and KEEPS the subject', async () => {
        // The reply still has to say what it is about — dropping the subject would make the
        // one scope that always works also the one that cannot echo.
        const ctx = await supportOf({ recentOrder: ORDER, store: STORE, agency: AGENCY })
            .resolve('c1', { scope: 'platform' });
        return ctx.vendor === null && ctx.agency === null && ctx.subject.type === 'order';
    });

    await assertAsync('⚠ scope agency on a PRODUCT context is 409, not a climb to some other order', async () => {
        // An agency attaches to a shipment, not to a product. Climbing past the product to
        // find an agency would answer about a purchase the customer is not looking at.
        const e = await supportErrorOf(
            { products: { [PRODUCT_ID]: PRODUCT }, store: STORE, recentOrder: ORDER, agency: AGENCY },
            { scope: 'agency', hintProductId: PRODUCT_ID },
        );
        return e?.code === ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE
            && e.statusCode === 409
            && (e.details as { subjectType?: string })?.subjectType === 'product';
    });

    await assertAsync('scope agency on an order with no shipment is the same 409', async () => {
        const e = await supportErrorOf(
            { recentOrder: ORDER, store: STORE, agency: null },
            { scope: 'agency' },
        );
        return e?.code === ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE && e.statusCode === 409;
    });

    await assertAsync('⚠ a named scope with NO context at all is the 404, a different question', async () => {
        const e = await supportErrorOf({}, { scope: 'vendor' });
        return e?.code === ERROR_CODES.BOT_SUPPORT_NO_CONTEXT && e.statusCode === 404;
    });

    await assertAsync('⚠ neither refusal is reachable from `auto` or `platform`', async () => {
        const auto = await supportErrorOf({}, { scope: 'auto' });
        const platform = await supportErrorOf({}, { scope: 'platform' });
        return auto === null && platform === null;
    });

    assert('⚠ the delivery company is read from SHIPMENTS, never from the order items', () => {
        // Reading `items[].delivery.agency_id` would name an agency at checkout time — one
        // the customer has never been shown anywhere, and one reassignment can still change.
        const source = stripComments(read('modules/bot-surface/services/support-context.service.ts'));
        return source.includes('findByOrderId')
            && !/items\s*\[|delivery\.agency_id/.test(source);
    });

    assert('⚠ the support route takes no store slug or agency id — the parties are the ANSWER', () => {
        // Accepting one would turn a support-routing read into a directory lookup over every
        // store on the platform, from a chat window, with no relationship to the customer.
        const validators = stripComments(read('modules/bot-surface/validators/bot.validators.ts'));
        const block = validators.slice(validators.indexOf('BotSupportContextSchema'));
        return block.includes('.strict()')
            && !/storeSlug|agencyId|vendorId/.test(block.slice(0, block.indexOf('.strict()')));
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('10 · Proactive messaging (GAP-012)');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the two messaging routes are mounted, and classified opposite ways', () => {
        const window = BOT_ROUTES.find((r) => r.tool === 'messaging_get_window');
        const notify = BOT_ROUTES.find((r) => r.tool === 'messaging_notify_customer');
        // `window` reads one Redis TTL and must survive a `readonly` maintenance window — a
        // flow that cannot ask whether it may still speak has to guess. `notify` mints a pay
        // link AND messages a real person, so a retry does two things nobody asked for.
        return window?.mutating === false && notify?.mutating === true;
    });

    assert('⚠ `notify` takes a SITUATION from a closed set, never a message', () => {
        const validators = stripComments(read('modules/bot-surface/validators/bot.validators.ts'));
        const block = validators.slice(
            validators.indexOf('BotMessagingNotifySchema'),
            validators.indexOf('BotNoArgsSchema'),
        );
        // The whole design: a free-text route could send NOTHING outside WhatsApp's service
        // window — the only situation it would be reached in — and would make "no proactive
        // marketing" unenforceable by anything but good intentions.
        return block.includes('z.enum(BOT_NOTIFY_SITUATIONS)')
            && block.includes('.strict()')
            && !/\b(text|body|message|content|template)\b\s*:/.test(block);
    });

    assert('every situation the bot may raise is a real catalog situation', () =>
        BOT_NOTIFY_SITUATIONS.every((s) =>
            (CUSTOMER_NOTIFICATION_TYPES as readonly string[]).includes(s)));

    assert('…and every one has a WhatsApp template, which is the point of the gap', () =>
        BOT_NOTIFY_SITUATIONS.every((s) =>
            !!customerWhatsAppTemplateName(s as CustomerNotificationType)));

    assert('⚠ there is no marketing situation, and no situation may be added silently', () =>
        // ARCHITECTURE.md § 12 lists proactive marketing as deliberately not built, and the
        // `marketing` preference defaults to false and gates nothing yet. This is the pin.
        BOT_NOTIFY_SITUATIONS.length === 1
        && BOT_NOTIFY_SITUATIONS[0] === 'order.payment_link');

    assert('the door delegates to the notification stack rather than sending anything', () => {
        const controller = stripComments(
            read('modules/bot-surface/controllers/bot-messaging.controller.ts'),
        );
        // One send path, so the free-form-vs-template branch cannot be got wrong twice.
        return /getCustomerNotificationHandler\(\)\.notify\(/.test(controller)
            && !/WaServiceMessage|getWhatsAppMessagingService|TelegramNotificationService/.test(controller);
    });

    assert('⚠ Telegram is answered `applicable: false`, not merely `open: true`', () => {
        const controller = stripComments(
            read('modules/bot-surface/controllers/bot-messaging.controller.ts'),
        );
        // "The window is open" and "there is no window" are different facts. A caller that
        // collapses them writes a Telegram flow around a deadline that does not exist.
        return /applicable:\s*false/.test(controller) && /applicable:\s*true/.test(controller);
    });

    assert('⚠ the pay-link notification is MINTED at send time, not read off the row', () => {
        const controller = stripComments(
            read('modules/bot-surface/controllers/bot-messaging.controller.ts'),
        );
        // Reading an existing handle would send one minted twenty-nine minutes ago, so the
        // message arrives with a link that dies in sixty seconds.
        return /payLinkService\.mint\(/.test(controller)
            && !/transaction\.payLink\.token/.test(controller);
    });

    assert('⚠ registration seeds the channel the customer arrived on', () => {
        // Without this every proactive template GAP-012 asks for is unreachable for exactly
        // the population GAP-002 creates: the three channel flags all default to FALSE, so a
        // bot-registered customer had no channel at all.
        const registration = stripComments(
            read('modules/bot-surface/services/bot-registration.service.ts'),
        );
        return /seedNotificationChannel\(/.test(registration)
            && /upsertPreferences\(/.test(registration)
            // Both CREATE paths, never the backfill branch — an account of two years standing
            // has a preference somebody chose.
            && (registration.match(/this\.seedNotificationChannel\(/g) ?? []).length === 2;
    });

    assert('⚠ seeding a channel never fails a registration', () => {
        const registration = read('modules/bot-surface/services/bot-registration.service.ts');
        const body = registration.slice(registration.indexOf('private async seedNotificationChannel'));
        return body.slice(0, body.indexOf('private async bind')).includes('catch');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('11 · The channel reply — the body the automation layer POSTs unmodified');
    // ═════════════════════════════════════════════════════════════════════════
    //
    // The renderer is pure, so every branch is assertable with nothing running. What is
    // pinned here is the WIRE SHAPE, because that is the half nobody can check by reading:
    // a `reply_markup` with the wrong nesting produces a Telegram 400 the automation layer
    // reports as its own failure, and a WhatsApp interactive one character over a Meta cap
    // is accepted and rendered truncated.

    const TG = '1804835114';
    const WA = '237699000771';

    assert('the Telegram phone prompt is a complete `sendMessage` body', () => {
        const { prompt, requestContact } = onboardingPromptFor('phone', 'telegram', 'en');
        const reply = renderBotReply(
            { kind: 'contact_request', text: prompt, buttonLabel: botChrome('contactButton', 'en') },
            'telegram',
            TG,
        );
        const body = reply.body as Record<string, any>;
        return requestContact === true
            && reply.channel === 'telegram'
            && reply.method === 'sendMessage'
            && body.chat_id === TG
            && body.text === prompt
            && body.reply_markup.keyboard[0][0].request_contact === true
            && body.reply_markup.keyboard[0][0].text === '📱 Share my number'
            && body.reply_markup.one_time_keyboard === true
            && body.reply_markup.resize_keyboard === true;
    });

    assert('⚠ a Telegram reply with no keyboard of its own REMOVES the last one', () => {
        const body = renderBotReply({ kind: 'text', text: 'hi' }, 'telegram', TG).body as any;
        // The turn after the contact share. Making this the automation layer's job is a
        // branch that has to be got right on every future turn rather than once.
        return body.reply_markup.remove_keyboard === true;
    });

    assert('the WhatsApp text body matches the Cloud API shape the platform already sends', () => {
        const reply = renderBotReply({ kind: 'text', text: 'hi' }, 'whatsapp', WA);
        const body = reply.body as Record<string, any>;
        return reply.method === 'messages'
            && body.messaging_product === 'whatsapp'
            && body.recipient_type === 'individual'
            && body.to === WA
            && body.type === 'text'
            && body.text.body === 'hi'
            && body.text.preview_url === false;
    });

    /**
     * The address picker, which is the one intent both channels render as a real control.
     */
    const addressPicker = (count: number): BotReplyIntent => ({
        kind: 'choice',
        text: botChrome('choosePrompt', 'fr'),
        listButton: botChrome('chooseListButton', 'fr'),
        sectionTitle: botChrome('chooseSectionTitle', 'fr'),
        options: Array.from({ length: count }, (_, i) => ({
            id: `gc_${'a'.repeat(43)}${i}`.slice(0, 46),
            label: `École Bilingue la Pouponnière d'AKWA, Douala I, Wouri, Littoral, Cameroun ${i}`,
            shortLabel: `Akwa ${i}`,
            description: `École Bilingue la Pouponnière d'AKWA, Douala I, Wouri ${i}`,
        })),
    });

    assert('Telegram renders a picker as ONE OPTION PER ROW carrying the ref', () => {
        const body = renderBotReply(addressPicker(2), 'telegram', TG).body as any;
        const rows = body.reply_markup.inline_keyboard;
        return rows.length === 2
            && rows.every((r: unknown[]) => r.length === 1)
            && rows[0][0].callback_data.startsWith('gc_')
            && rows[0][0].text.startsWith('École Bilingue');
    });

    assert('⚠ a REAL geo-candidate ref fits Telegram\'s 64-byte callback_data cap', () => {
        // The walkthrough told the automation layer the opposite — "a ref plus any prefix
        // you add will silently truncate" — and had it keep the refs in n8n's own state.
        // Measured against the handles § 6 actually minted rather than argued, because the
        // failure is invisible: an oversized `callback_data` is not rejected, the keyboard
        // simply does nothing when tapped.
        return refs.length > 0
            && refs.every((r) => Buffer.byteLength(r, 'utf8') <= __TG_LIMITS.CALLBACK_DATA_BYTES);
    });

    assert('⚠ an id Telegram cannot carry DROPS the keyboard rather than truncating it', () => {
        const oversized: BotReplyIntent = {
            ...(addressPicker(1) as Extract<BotReplyIntent, { kind: 'choice' }>),
            options: [{ id: 'x'.repeat(65), label: 'somewhere' }],
        };
        const body = renderBotReply(oversized, 'telegram', TG).body as any;
        // The question survives and can be answered by typing; a picker that looks perfect
        // and does nothing is the worse outcome.
        return body.reply_markup.inline_keyboard === undefined
            && body.reply_markup.remove_keyboard === true
            && typeof body.text === 'string';
    });

    assert('⚠ WhatsApp renders an address picker as a LIST even when only two fit buttons', () => {
        // A button has nowhere to put a description, so two candidates would render as
        // `Akwa 0` / `Akwa 1` — not a choice anybody can make. Found by this assertion.
        const body = renderBotReply(addressPicker(2), 'whatsapp', WA).body as any;
        const rows = body.interactive.action.sections[0].rows;
        return body.interactive.type === 'list'
            && body.interactive.action.button === botChrome('chooseListButton', 'fr')
            && rows.length === 2
            && rows[0].title === 'Akwa 0'
            && rows[0].title.length <= 24
            && rows[0].description.length <= 72
            && rows[0].id.startsWith('gc_');
    });

    assert('WhatsApp renders few SHORT options as reply buttons', () => {
        const intent: BotReplyIntent = {
            kind: 'choice',
            text: 'Which one?',
            listButton: 'Choose',
            sectionTitle: 'Options',
            options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }],
        };
        const body = renderBotReply(intent, 'whatsapp', WA).body as any;
        return body.interactive.type === 'button'
            && body.interactive.action.buttons.length === 2
            && body.interactive.action.buttons[0].type === 'reply'
            && body.interactive.action.buttons[0].reply.id === 'a';
    });

    assert('⚠ a WhatsApp list is capped at TEN rows — Meta rejects an eleventh outright', () => {
        const body = renderBotReply(addressPicker(14), 'whatsapp', WA).body as any;
        return body.interactive.action.sections[0].rows.length === 10;
    });

    assert('the payment link renders a URL button on both channels', () => {
        const intent: BotReplyIntent = {
            kind: 'link',
            text: botChrome('payPrompt', 'en'),
            label: botChrome('payButton', 'en'),
            url: 'https://shop.example/pay/abc',
        };
        const tg = renderBotReply(intent, 'telegram', TG).body as any;
        const wa = renderBotReply(intent, 'whatsapp', WA).body as any;
        return tg.reply_markup.inline_keyboard[0][0].url === 'https://shop.example/pay/abc'
            && wa.interactive.type === 'cta_url'
            && wa.interactive.action.name === 'cta_url'
            && wa.interactive.action.parameters.url === 'https://shop.example/pay/abc'
            && wa.interactive.action.parameters.display_text === 'Pay now';
    });

    assert('⚠ WhatsApp has no contact control, so that intent degrades to its TYPED copy', () => {
        // The Telegram copy tells the customer to tap a button no WhatsApp client draws.
        const { prompt } = onboardingPromptFor('phone', 'whatsapp', 'en');
        const body = renderBotReply(
            { kind: 'contact_request', text: prompt, buttonLabel: 'ignored' },
            'whatsapp',
            WA,
        ).body as any;
        return body.type === 'text'
            && body.text.body === prompt
            && prompt.includes('+237600000000');
    });

    assert('an over-long message is TRUNCATED rather than rejected by the platform', () => {
        const long = 'x'.repeat(9000);
        const tg = renderBotReply({ kind: 'text', text: long }, 'telegram', TG).body as any;
        const wa = renderBotReply({ kind: 'text', text: long }, 'whatsapp', WA).body as any;
        return tg.text.length === __TG_LIMITS.TEXT && wa.text.body.length === 4096;
    });

    /**
     * ⚠ **An answer from a set known in advance is a BUTTON, never a typed word.**
     *
     * The prompts used to end with *"just say \"skip\" if you would rather not"*, which
     * meant a French customer typed *« passer »* and something downstream had to know that
     * five spellings are one intent — in the layer with no copy table. These assertions pin
     * both halves of the correction: the prose went back to being a question, and the
     * refusal became a token that is the same in every language.
     */
    const skipAction: BotReplyIntent = {
        kind: 'text',
        text: botChrome('choosePrompt', 'fr'), // stand-in; the real text is the step prompt
        actions: [{ id: skipActionId('email'), label: botChrome('skipButton', 'fr') }],
    };

    assert('⚠ a skippable step renders a Telegram inline BUTTON, not an instruction', () => {
        const body = renderBotReply(skipAction, 'telegram', TG).body as any;
        const button = body.reply_markup.inline_keyboard[0][0];
        return button.callback_data === 'skip:email'
            && button.text === 'Passer'
            && body.reply_markup.remove_keyboard === undefined;
    });

    assert('⚠ …and a WhatsApp reply BUTTON, never a list, however the content reads', () => {
        // A list hides its rows behind a "Choose" tap, which is the wrong control for an
        // action beside an open question — the customer is deciding whether to answer.
        const body = renderBotReply(skipAction, 'whatsapp', WA).body as any;
        return body.interactive.type === 'button'
            && body.interactive.action.buttons[0].reply.id === 'skip:email'
            && body.interactive.action.buttons[0].reply.title === 'Passer';
    });

    assert('⚠ the token is IDENTICAL in every language — only the label is translated', () => {
        const ids = BOT_COPY_LANGUAGES.map((lang) => {
            const body = renderBotReply(
                {
                    kind: 'text',
                    text: 'q',
                    actions: [{ id: skipActionId('address'), label: botChrome('skipButton', lang) }],
                },
                'telegram',
                TG,
            ).body as any;
            return body.reply_markup.inline_keyboard[0][0].callback_data;
        });
        const labels = BOT_COPY_LANGUAGES.map((lang) => botChrome('skipButton', lang));
        // One id for five labels: the whole point. `ar` and `en` differ, so the labels are
        // genuinely translated rather than all falling back to English.
        return new Set(ids).size === 1
            && ids[0] === 'skip:address'
            && new Set(labels).size > 1;
    });

    assert('a REQUIRED step still renders a plain message that removes the keyboard', () => {
        const body = renderBotReply({ kind: 'text', text: 'What name?' }, 'telegram', TG).body as any;
        return body.reply_markup.remove_keyboard === true
            && body.reply_markup.inline_keyboard === undefined;
    });

    assert('⚠ NO skippable prompt teaches a magic word, in any language', () => {
        // The inverted assertion. It used to demand that word be present.
        const banned = /skip|passer|saltar|omitir|تخط|facultat|opcional|optional|"|«/i;
        const offenders: string[] = [];
        for (const step of __SKIPPABLE_STEPS) {
            for (const lang of BOT_COPY_LANGUAGES) {
                for (const channel of ['telegram', 'whatsapp'] as const) {
                    const { prompt } = onboardingPromptFor(step, channel, lang);
                    if (banned.test(prompt)) offenders.push(`${step}/${channel}:${lang}`);
                }
            }
        }
        if (offenders.length) console.error('     ↳', offenders.join(', '));
        return __SKIPPABLE_STEPS.length > 0 && offenders.length === 0;
    });

    assert('⚠ the action-id cap agrees with the renderer\'s Telegram cap', () =>
        // Two modules name 64 because the token module must not import the renderer. This
        // is what stops that duplication becoming a divergence.
        __CALLBACK_DATA_BYTES === __TG_LIMITS.CALLBACK_DATA_BYTES);

    assert('⚠ every chrome string exists in all five languages AND fits its cap', () => {
        assertBotChromeCopyFits();
        // Re-checked here rather than trusting the boot assert alone: the assert is what
        // catches a NEW string, and this is what catches somebody loosening the assert.
        return (Object.keys(__CHROME_TABLE) as (keyof typeof __CHROME_TABLE)[]).every((key) => {
            const { copy, cap } = __CHROME_TABLE[key];
            return BOT_COPY_LANGUAGES.every(
                (lang) => copy[lang].trim().length > 0 && (cap === null || copy[lang].length <= cap),
            );
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('12 · Source scans — the structural invariants nothing behavioural sees');
    // ═════════════════════════════════════════════════════════════════════════

    const files = moduleFiles();
    const offenders = (pattern: RegExp): string[] =>
        files.filter((f) => pattern.test(stripComments(f.body))).map((f) => f.name);

    assert('the module has files to scan', () => files.length >= 15);

    assert('⚠ NO customer session is ever minted on this surface', () => {
        const bad = offenders(/issueTokenPair|setAuthCookies|rotateRefreshToken|loginSessionStore|messagingLoginService/);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('⚠ no controller reads `req.auth` — a bot request is not a session', () => {
        const bad = offenders(/req\.auth/);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('⚠ no handler takes an identity out of a body or a path', () => {
        // `req.body.customerId` / `req.params.userId` and friends. The envelope is the only
        // identity, and it is consumed by the middleware before a handler runs.
        const bad = offenders(/req\.(body|params|query)\.(customerId|userId|customer_id|user_id)/);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0;
    });

    assert('every controller resolves its caller through `botCallerOf`', () => {
        const controllers = files.filter((f) => f.name.includes('controllers'));
        const bad = controllers.filter((f) => !f.body.includes('botCallerOf')).map((f) => f.name);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return controllers.length >= 9 && bad.length === 0;
    });

    assert('⚠ the router mounts BOTH credentials, and identity before idempotency', () => {
        const routes = stripComments(read('modules/bot-surface/bot.routes.ts'));
        const iService = routes.indexOf('router.use(requireServiceToken)');
        const iSecret = routes.indexOf('router.use(requireBotWebhookSecret)');
        const iIdentity = routes.indexOf('router.use(requireBotIdentity)');
        const iIdem = routes.indexOf('router.use(botIdempotency)');
        return iService >= 0 && iSecret > iService && iIdentity > iSecret && iIdem > iIdentity;
    });

    assert('⚠ the reply interceptor is mounted TWICE — above identity AND below idempotency', () => {
        /**
         * The single most tidy-up-able line in the module, and removing either mount is
         * silent. `res.json` wrappers run in reverse order of installation, so:
         *
         *   drop the OUTER one and the three identity refusals — raised by a guard that
         *   throws, skipping everything below it — go out with no message at all;
         *   drop the INNER one and the idempotency guard captures a body with no `reply`,
         *   so every retried registration answers 200 with nothing to send.
         *
         * Neither failure shows up in a status code, which is why this is pinned by
         * counting rather than by trusting the comment beside it.
         */
        const routes = stripComments(read('modules/bot-surface/bot.routes.ts'));
        const mounts = (routes.match(/router\.use\(attachBotReply\)/g) ?? []).length;
        const first = routes.indexOf('router.use(attachBotReply)');
        const last = routes.lastIndexOf('router.use(attachBotReply)');
        return mounts === 2
            && first < routes.indexOf('router.use(requireBotIdentity)')
            && last > routes.indexOf('router.use(botIdempotency)');
    });

    assert('⚠ the identity guard stamps `req.bot` BEFORE it may throw', () => {
        // Otherwise a refusal carries neither `error.customerMessage` nor `reply`, which
        // is the state `BOT_IDENTITY_NEEDS_CONTACT` shipped in: a sentence telling the
        // customer to tap a button, on a response that rendered no button and, before the
        // fix, no sentence either.
        const guard = stripComments(read('modules/bot-surface/middlewares/bot-identity.middleware.ts'));
        return guard.indexOf('req.bot = {') < guard.indexOf('service.resolve(identity)');
    });

    assert('⚠ no GET is mounted — the identity envelope is a body, never a query string', () => {
        const bad = offenders(/router\.get\(/);
        if (bad.length) console.error('     ↳', bad.join(', '));
        return bad.length === 0 && !BOT_ROUTES.some((r) => (r.method as string) === 'GET');
    });

    assert('the surface is mounted once, at /internal/bot, in api/index.ts', () => {
        const index = read('api/index.ts');
        return (index.match(/router\.use\('\/internal\/bot'/g) ?? []).length === 1;
    });

    assert('⚠ BOTH order reads strip the delivery code', () => {
        const controller = read('modules/bot-surface/controllers/bot-order.controller.ts');
        // `getGroup` maps over a list; `getOrder` applies it to one. Both must be present.
        return controller.includes('dtos.map(stripDeliveryCodes)')
            && controller.includes('stripDeliveryCodes(dto)');
    });

    assert('⚠ only the dedicated route discloses a delivery code', () => {
        const controller = stripComments(read('modules/bot-surface/controllers/bot-order.controller.ts'));
        const disclosing = controller.split('static ')
            .filter((block) => block.includes('getCodBlocksForOrders') || block.includes('resendCodeAsCustomer'))
            .map((block) => block.slice(0, block.indexOf('=')).trim());
        return disclosing.length === 2
            && disclosing.includes('getCodCode')
            && disclosing.includes('resendCodCode');
    });

    assert('the route table imports nothing — maintenance mode reads it', () => {
        const table = read('modules/bot-surface/domain/bot-route-table.ts');
        return !/^\s*import\s/m.test(table);
    });

    assert('the barrel does not re-export the router', () => {
        const barrel = stripComments(read('modules/bot-surface/index.ts'));
        return !barrel.includes('bot.routes') && !barrel.includes('Router');
    });

    assert('the barrel does not export either Redis store', () => {
        const barrel = stripComments(read('modules/bot-surface/index.ts'));
        return !barrel.includes('IdempotencyStore') && !barrel.includes('GeoCandidateStore');
    });

    assert('⚠ the idempotency store claims with `SET … NX` and never GET-then-SET', () => {
        const source = stripComments(read('modules/bot-surface/services/bot-idempotency.store.ts'));
        return /NX:\s*true/.test(source);
    });

    assert('⚠ the geo store spends with a Lua script, not GETDEL — dev Redis is 3.0', () => {
        const source = read('modules/bot-surface/services/geo-candidate.store.ts');
        return source.includes('redis.call("get"')
            && source.includes('redis.call("del"')
            && !/getDel|GETDEL/.test(stripComments(source));
    });

    assert('⚠ the idempotency guard is bounded — a dead Redis must refuse, not hang', () => {
        const source = stripComments(read('modules/bot-surface/middlewares/bot-idempotency.middleware.ts'));
        return source.includes('REDIS_OP_TIMEOUT_MS')
            && source.includes('Promise.race')
            && source.includes('BOT_IDEMPOTENCY_STORE_UNAVAILABLE');
    });

    assert('⚠ `POST /addresses` accepts a handle and NEVER coordinates', () => {
        const validators = stripComments(read('modules/bot-surface/validators/bot.validators.ts'));
        const addBlock = validators.slice(
            validators.indexOf('BotAddAddressSchema'),
            validators.indexOf('BotAddressParamSchema'),
        );
        return addBlock.includes('geoCandidateRef')
            && !/coordinates|\blat\b|\blng\b|\bgeo\b:/.test(addBlock);
    });

    assert('⚠ the saved-address builder writes no `location` key at all', () => {
        // A null in the 2dsphere-indexed array makes the whole customer document
        // unwritable, and the rule is: a point we do not have is a key we do not write.
        const source = stripComments(read('modules/bot-surface/controllers/bot-profile.controller.ts'));
        const builder = source.slice(source.indexOf('function toSavedAddressInput'));
        return !/\blocation\s*:/.test(builder);
    });

    assert('every module file is reachable from the router or the barrel', () => {
        // A controller nobody mounts is the failure the closed registry exists to stop, and
        // this catches the one case it cannot: a file that no import graph reaches at all.
        //
        // ⚠ The haystack is the WHOLE of `src/`, not this module. It was the module alone
        // until 2026-08-25 and that was a false-positive generator: `domain/bot-error-copy.ts`
        // is imported by `api/middlewares/error-handler.middleware.ts` and by `lifecycle.ts`,
        // neither of which lives here, so a properly wired file read as an orphan. "Reachable"
        // means reachable from anywhere, and scanning anywhere is what makes that true.
        const imported = allSourceFiles().join('\n');
        const orphans = files
            .filter((f) => !f.name.endsWith('index.ts') && !f.name.endsWith('bot.routes.ts'))
            .filter((f) => {
                const stem = path.basename(f.name).replace(/\.ts$/, '');
                return !imported.includes(`/${stem}'`) && !imported.includes(`/${stem}"`);
            })
            .map((f) => f.name);
        if (orphans.length) console.error('     ↳', orphans.join(', '));
        return orphans.length === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    console.log(`\n${'─'.repeat(76)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(76)}\n`);

    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('test:bot-surface crashed:', err);
    process.exit(1);
});
