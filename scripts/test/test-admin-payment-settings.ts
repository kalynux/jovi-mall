/**
 * test:admin-payment-settings — the internal admin payment-routing routes (ADR-A08, W4a).
 *
 * Drives the REAL router over HTTP: `buildAdminDevToolsRouter` → `/payments`, with the real error
 * handler, and the settings service behind its store seam (in memory, no database). So what is
 * asserted is the wire shape wi-admin reads, not a function's return value.
 *
 *   1. GET          the four blocks, the defaults with no document, every adapter listed
 *   2. PUT          `.strict()` (a legacy `gateway` is a 400), a hard rule → 422 with
 *                   `details.errors`, a valid write → previous / settings / changed with the actor
 *                   from the headers, a stale version → 409, and the GET reflecting the write
 *   3. Standing     the stored state validated against itself: soft problems in `warnings`, a
 *                   broken state in `errors` — two keys, because "payments are broken now" and
 *                   "note this" are different screens
 *
 * Run: npm run test:admin-payment-settings
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';
// The config objects are frozen at import, so the fixtures go first. NotchPay is configured;
// My-CoolPay deliberately is NOT, which is how § 3 produces a broken stored state.
process.env.NOTCHPAY_WEBHOOK_SECRET = 'hsk_test.fixture_hash_key';
process.env.NOTCHPAY_PUBLIC_KEY = 'pk_test.fixture_public_key';
process.env.MYCOOLPAY_PUBLIC_KEY = '';
process.env.MYCOOLPAY_PRIVATE_KEY = '';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

// TYPE-ONLY, and load-bearing: `req.auth` and `req.requestId` are declared by `declare global`
// blocks inside these two modules, and bare `ts-node` type-checks only what the program reaches.
// The admin-caller and error-handler middlewares use both fields without importing either, so
// without these lines the suite does not compile. `import type` is erased at runtime, so the
// modules' own imports never execute here.
import type {} from '../../src/api/middlewares/auth.middleware';
import type {} from '../../src/api/middlewares/request-id.middleware';
import express, { RequestHandler } from 'express';
import { AddressInfo } from 'net';
import { originalConsole } from '../../src/core/logging/sink-guard';
import {
    PaymentSettingsDocument,
    PaymentSettingsStore,
    __resetPaymentSettingsCacheForTests,
    __setPaymentSettingsStoreForTests,
} from '../../src/modules/payments/services/payment-settings.service';
import { buildAdminDevToolsRouter } from '../../src/modules/dev-tools/admin-dev-tools.routes';
import { errorHandlerMiddleware } from '../../src/api/middlewares/error-handler.middleware';
import { DEFAULT_PAYMENT_SETTINGS } from '../../src/modules/payments/domain/payment-routing';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
    } catch (err) {
        originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        passed++;
        originalConsole.log(`  ✅ ${name}`);
    } else {
        failed++;
        originalConsole.error(`  ❌ FAIL: ${name}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

// ── The in-memory store ──────────────────────────────────────────────────────

let doc: PaymentSettingsDocument | null = null;

const memoryStore: PaymentSettingsStore = {
    ready: () => true,
    read: async () => (doc ? { ...doc } : null),
    create: async (fields) => {
        if (doc) throw Object.assign(new Error('duplicate key'), { code: 11000 });
        doc = { ...fields, version: 1 } as PaymentSettingsDocument;
        return { ...doc };
    },
    compareAndSet: async (expectedVersion, fields) => {
        if (!doc || doc.version !== expectedVersion) return null;
        doc = { ...doc, ...fields, version: expectedVersion + 1 } as PaymentSettingsDocument;
        return { ...doc };
    },
};

/**
 * Stands in for `requireAdminCaller`, which the real mount puts in front: it would refuse a call
 * with no actor, so the headers it guarantees are set here.
 */
const actorHeaders: RequestHandler = (req, _res, next) => {
    req.headers['x-actor-id'] = '66a2aabbccddeeff00112233';
    req.headers['x-actor-name'] = 'Test Administrator';
    next();
};

type Json = any;

(async () => {
    __setPaymentSettingsStoreForTests(memoryStore);
    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);

    const app = express();
    app.use(express.json());
    app.use('/dev-tools', buildAdminDevToolsRouter([actorHeaders]));
    app.use(errorHandlerMiddleware);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dev-tools/payments`;

    const call = async (method: 'GET' | 'PUT', body?: unknown): Promise<{ status: number; json: Json }> => {
        const response = await fetch(base, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() };
    };

    try {
        // ═══ 1. GET ═════════════════════════════════════════════════════════════
        section('1. GET — the shape wi-admin reads');

        const first = await call('GET');
        const data = first.json?.data ?? {};

        await assert('200 with settings, aggregators, effectiveProviders, errors and warnings', () =>
            first.status === 200
            && ['settings', 'aggregators', 'effectiveProviders', 'errors', 'warnings'].every((key) => key in data));

        await assert('no document → the defaults at version 0, NotchPay active for both', () => {
            const notchpay = data.aggregators.find((a: Json) => a.name === 'NOTCHPAY');
            return data.settings.version === 0 && data.settings.updatedBy === null
                && data.settings.collectionAggregator === 'NOTCHPAY'
                && notchpay?.activeForCollections === true && notchpay?.activeForPayouts === true;
        });

        await assert('every registered adapter is listed, configured or not', () =>
            ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'].every((name) => data.aggregators.some((a: Json) => a.name === name))
            && data.aggregators.find((a: Json) => a.name === 'MYCOOLPAY').configured === false);

        await assert('effectiveProviders names the aggregator (this surface is admin-only)', () =>
            data.effectiveProviders.length > 0
            && data.effectiveProviders.every((e: Json) => e.aggregator === 'NOTCHPAY'));

        // ═══ 2. PUT ═════════════════════════════════════════════════════════════
        section('2. PUT — validate, compare-and-set, answer with what was replaced');

        const legacy = await call('PUT', { expectedVersion: 0, reason: 'legacy client', gateway: 'NOTCHPAY' });
        await assert('an unknown key (a legacy `gateway`) is a 400 — .strict()', () => legacy.status === 400);

        const stripe = await call('PUT', { collectionAggregator: 'STRIPE', expectedVersion: 0, reason: 'wrong switch' });
        await assert('STRIPE as the collection aggregator → 422 PAYMENT_SETTINGS_INVALID with details.errors[]', () =>
            stripe.status === 422
            && stripe.json.error.code === 'PAYMENT_SETTINGS_INVALID'
            && stripe.json.error.details.errors.some((e: Json) => e.code === 'COLLECTION_AGGREGATOR_IS_STRIPE'));

        await assert('…and nothing was written', () => doc === null);

        const write = await call('PUT', { providers: { ORANGE: { enabled: false } }, expectedVersion: 0, reason: 'Orange push failing' });
        await assert('a valid write → 200 with previous, settings, changed and convergenceSeconds', () =>
            write.status === 200
            && write.json.data.previous.providers.ORANGE.enabled === true
            && write.json.data.settings.providers.ORANGE.enabled === false
            && write.json.data.changed.join() === 'providers'
            && typeof write.json.data.convergenceSeconds === 'number');

        await assert('the actor comes from the admin-caller headers, never the body', () =>
            write.json.data.settings.updatedBy?.id === '66a2aabbccddeeff00112233'
            && write.json.data.settings.updatedBy?.name === 'Test Administrator'
            && write.json.data.settings.reason === 'Orange push failing');

        const stale = await call('PUT', { providers: { ORANGE: { enabled: true } }, expectedVersion: 0, reason: 'second operator' });
        await assert('a stale expectedVersion → 409 PAYMENT_SETTINGS_VERSION_CONFLICT with both versions', () =>
            stale.status === 409
            && stale.json.error.code === 'PAYMENT_SETTINGS_VERSION_CONFLICT'
            && stale.json.error.details?.expectedVersion === 0
            && stale.json.error.details?.currentVersion === 1);

        const after = await call('GET');
        await assert('the GET reflects the write', () =>
            after.json.data.settings.version === 1 && after.json.data.settings.providers.ORANGE.enabled === false);

        // ═══ 3. Standing issues ═════════════════════════════════════════════════
        section('3. Standing issues — errors and warnings are different keys');

        await assert('a valid stored state has errors: [] (the key is present, and empty)', () =>
            Array.isArray(after.json.data.errors) && after.json.data.errors.length === 0);

        /**
         * A soft problem on a valid state. MOOV is enabled and NotchPay declares no MOOV, so it
         * cannot be offered — the state is still valid, so this is a warning, not an error.
         */
        __resetPaymentSettingsCacheForTests({
            ...DEFAULT_PAYMENT_SETTINGS,
            providers: { ...DEFAULT_PAYMENT_SETTINGS.providers, MOOV: { enabled: true } },
            version: 2,
        }, true);
        const soft = await call('GET');
        await assert('an unroutable enabled provider → warnings has PROVIDER_UNROUTABLE, errors is empty', () =>
            soft.json.data.errors.length === 0
            && soft.json.data.warnings.some((w: Json) => w.code === 'PROVIDER_UNROUTABLE' && w.provider === 'MOOV'));

        /**
         * The broken state: the stored collection aggregator has no credentials on this
         * deployment (a key removed after a switch). New charges are being refused. This must be
         * in `errors`, not mixed into `warnings`, so the screen can say so in red.
         */
        __resetPaymentSettingsCacheForTests({
            ...DEFAULT_PAYMENT_SETTINGS,
            collection_aggregator: 'MYCOOLPAY',
            version: 3,
        }, true);
        const broken = await call('GET');
        await assert('credentials gone after a switch → errors has COLLECTION_AGGREGATOR_NOT_CONFIGURED', () =>
            broken.status === 200
            && broken.json.data.errors.some((e: Json) => e.code === 'COLLECTION_AGGREGATOR_NOT_CONFIGURED' && e.aggregator === 'MYCOOLPAY'));

        await assert('…and the hard issue is NOT also in warnings', () =>
            !broken.json.data.warnings.some((w: Json) => w.code === 'COLLECTION_AGGREGATOR_NOT_CONFIGURED'));

        await assert('…and nothing is offered, which is what "broken now" means', () =>
            broken.json.data.effectiveProviders.length === 0);
    } finally {
        server.close();
        __setPaymentSettingsStoreForTests(null);
    }

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
