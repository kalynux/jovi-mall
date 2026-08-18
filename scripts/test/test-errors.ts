/**
 * Test: the Phase-16 error system and rate-limit policy — the pure parts.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free throughout, and it prints through `originalConsole` because the console bridge
 * would otherwise swallow its own results.
 *
 * Seven sections, each guarding something that was actually wrong:
 *
 *   1. Taxonomy      the nine names against a HARDCODED literal. There is no shared package
 *                    across the three services, so this assertion IS the contract copy.
 *   2. Derivation    the status table, the integration-prefix rule, and override hygiene —
 *                    including the rule that an override must DISAGREE with the rules, so a
 *                    dead override cannot accumulate.
 *   3. The census    a static scan of every `createAppError(ERROR_CODES.X, N)` call site in
 *                    `src/`, asserting no code yields two categories. This is the section
 *                    that found `INTERNAL_SERVER_ERROR` raised at 502 in the calendar client.
 *   4. Detail policy what a client may see per category, and that the `{ cause }` leak is
 *                    closed for `external_service`.
 *   5. The envelope  the real handler rendered against a fake req/res: shape, `category`,
 *                    no stack ever, details omitted-not-null, and — the key one —
 *                    PRODUCTION AND DEVELOPMENT PRODUCE IDENTICAL OUTPUT for `internal`.
 *   6. Body parser   the branch that did not exist, so malformed JSON returned 500.
 *   7. Rate limits   the policy table's totality, ordering, and the exempt set.
 *
 * What this cannot cover: that the limiter's Redis store actually counts, and that it fails
 * OPEN when Redis dies. Both need a live server — see `npm run verify:rate-limit`.
 *
 * Run: npm run test:errors
 */
/**
 * Silence the logger's stdout stream BEFORE anything imports it.
 *
 * The handler under test now logs a structured record for every error, which is the point
 * of Phase 16 — and it means driving it forty times prints forty pretty-printed records
 * over the assertion output. `LOG_STDOUT=false` drops the stdout stream only; the ring
 * buffer and the (unconnected) Mongo sink are untouched, so nothing being tested changes.
 *
 * Must be set before the first import that reaches `logging.config.ts`, because the config
 * is read once when the logger is built.
 */
process.env.LOG_STDOUT = 'false';

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ZodError, z } from 'zod';
import {
    ERROR_CATEGORIES,
    ERROR_CATEGORY_VALUES,
    CATEGORY_OVERRIDES,
    CLIENT_SAFE_CATEGORIES,
    SUPPORT_HINTS,
    categoryFor,
    ErrorCategory,
} from '../../src/core/error-category';
import { projectDetails, projectMessage } from '../../src/core/error-detail-policy';
import { AppError, createAppError, DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import {
    errorHandlerMiddleware,
    classifyBodyParserFailure,
} from '../../src/api/middlewares/error-handler.middleware';
import {
    CALLER_CLASSES,
    POLICIES,
    GLOBAL_POLICY,
    IDENTITY_POLICY,
    AUTH_POLICY,
    ceilingFor,
} from '../../src/api/rate-limit/policy';
import { EXEMPT_PATHS, isExemptPathname } from '../../src/api/rate-limit/exempt-paths';
import { originalConsole } from '../../src/core/logging/sink-guard';

/**
 * Imported for their `declare global` side effects only.
 *
 * `req.requestId` and `req.auth` are augmentations declared in these two middleware files.
 * `tsc --noEmit` sees them because it compiles the whole project; ts-node compiles only the
 * graph reachable from THIS file, and the error handler imports neither of the files that
 * declare the fields it reads. Without these two lines the suite fails to compile against a
 * codebase that is perfectly well typed.
 */
import '../../src/api/middlewares/request-id.middleware';
import '../../src/api/middlewares/auth.middleware';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
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

// ─────────────────────────────────────────────────────────────────────────────
// A fake res, so the real middleware can be driven without a server.
// ─────────────────────────────────────────────────────────────────────────────

interface Captured {
    status: number;
    body: {
        success: boolean;
        requestId: string;
        error: {
            code: string;
            message: string;
            statusCode: number;
            category: string;
            details?: Record<string, unknown>;
        };
    };
}

function render(err: unknown, overrides: Record<string, unknown> = {}): Captured {
    const captured: Partial<Captured> = {};
    const res = {
        status(code: number) {
            captured.status = code;
            return this;
        },
        json(body: unknown) {
            captured.body = body as Captured['body'];
            return this;
        },
    };
    const req = {
        requestId: 'req_test',
        method: 'POST',
        path: '/api/orders',
        originalUrl: '/api/orders',
        ...overrides,
    };
     
    errorHandlerMiddleware(err, req as any, res as any, (() => undefined) as any);
    return captured as Captured;
}

/** Render the same error under a given NODE_ENV, restoring it afterwards. */
function renderUnder(nodeEnv: string, err: unknown): Captured {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    try {
        return render(err);
    } finally {
        process.env.NODE_ENV = previous;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The census — every createAppError call site in src/
// ─────────────────────────────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            sourceFiles(full, out);
        } else if (entry.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

interface CensusRow {
    code: string;
    statuses: Set<number>;
    categories: Set<string>;
}

function census(): Map<string, CensusRow> {
    // Matches `createAppError(ERROR_CODES.FOO, 404` across a line break, which is how most
    // of the 1362 sites are formatted. A dynamic status (a variable, a ternary) simply does
    // not match and is therefore not asserted on — reporting it as agreeing would be worse
    // than not reporting it.
    const pattern = /createAppError\(\s*ERROR_CODES\.([A-Z0-9_]+)\s*,\s*(\d{3})/g;
    const rows = new Map<string, CensusRow>();

    for (const file of sourceFiles(join(__dirname, '..', '..', 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(pattern)) {
            const [, code, statusRaw] = match;
            const status = Number(statusRaw);
            let row = rows.get(code);
            if (!row) {
                row = { code, statuses: new Set(), categories: new Set() };
                rows.set(code, row);
            }
            row.statuses.add(status);
            row.categories.add(categoryFor(code, status));
        }
    }
    return rows;
}

(async () => {
    originalConsole.log('\n══ Phase 16 — error system ══════════════════════════════════════════════');

    // ── 1. Taxonomy ──────────────────────────────────────────────────────────
    section('1. The taxonomy — the cross-service contract copy');

    assert('exactly nine categories, spelled as the other two services spell them', () => {
        const want = [
            'authentication', 'authorization', 'business_rule', 'conflict',
            'external_service', 'internal', 'not_found', 'rate_limit', 'validation',
        ];
        const got = [...ERROR_CATEGORY_VALUES].sort();
        return got.length === want.length && want.every((v, i) => got[i] === v);
    });

    assert('every category has a support hint — that is tier 3\'s whole view', () =>
        ERROR_CATEGORY_VALUES.every((c) => (SUPPORT_HINTS[c] ?? '').length > 20));

    assert('exactly two categories are NOT client-safe, and they are the right two', () => {
        const unsafe = ERROR_CATEGORY_VALUES.filter((c) => !CLIENT_SAFE_CATEGORIES.has(c));
        return unsafe.length === 2
            && unsafe.includes(ERROR_CATEGORIES.INTERNAL)
            && unsafe.includes(ERROR_CATEGORIES.EXTERNAL_SERVICE);
    });

    // ── 2. Derivation ────────────────────────────────────────────────────────
    section('2. Derivation — status table, prefix rule, override hygiene');

    const statusExpectations: Array<[number, ErrorCategory]> = [
        [400, ERROR_CATEGORIES.VALIDATION],
        [401, ERROR_CATEGORIES.AUTHENTICATION],
        [403, ERROR_CATEGORIES.AUTHORIZATION],
        [404, ERROR_CATEGORIES.NOT_FOUND],
        [409, ERROR_CATEGORIES.CONFLICT],
        [410, ERROR_CATEGORIES.NOT_FOUND],
        [413, ERROR_CATEGORIES.VALIDATION],
        [415, ERROR_CATEGORIES.VALIDATION],
        [422, ERROR_CATEGORIES.BUSINESS_RULE],
        [423, ERROR_CATEGORIES.BUSINESS_RULE],
        [429, ERROR_CATEGORIES.RATE_LIMIT],
        [500, ERROR_CATEGORIES.INTERNAL],
        [501, ERROR_CATEGORIES.INTERNAL],
        [502, ERROR_CATEGORIES.EXTERNAL_SERVICE],
        [503, ERROR_CATEGORIES.EXTERNAL_SERVICE],
        [504, ERROR_CATEGORIES.EXTERNAL_SERVICE],
    ];
    for (const [status, expected] of statusExpectations) {
        assert(`${status} → ${expected}`, () => categoryFor('SOME_UNMAPPED_CODE', status) === expected);
    }

    // 422 is the row worth stating out loud: this service uses it for business rules at 139
    // sites and 400 for schema failures at 136, and api-doc documents that split endpoint by
    // endpoint. Filing 422 as `validation` would tell a frontend to highlight a form field
    // for "this agency does not handle cash on delivery".
    assert('422 is business_rule, NOT validation — 139 call sites depend on that meaning', () =>
        categoryFor('COD_NOT_AVAILABLE_FOR_DIGITAL', 422) === ERROR_CATEGORIES.BUSINESS_RULE);

    assert('an unrecognised 4xx is business_rule (we understood it and refused)', () =>
        categoryFor('X', 451) === ERROR_CATEGORIES.BUSINESS_RULE);
    assert('an unrecognised 5xx is internal (a status we cannot classify is our bug)', () =>
        categoryFor('X', 507) === ERROR_CATEGORIES.INTERNAL);

    assert('the integration prefix rule fires on 5xx', () =>
        categoryFor('GOOGLE_CALENDAR_SYNC_FAILED', 500) === ERROR_CATEGORIES.EXTERNAL_SERVICE
        && categoryFor('WHATSAPP_SEND_FAILED', 502) === ERROR_CATEGORIES.EXTERNAL_SERVICE);

    assert('the integration prefix rule does NOT fire on 4xx', () =>
        // `GOOGLE_CALENDAR_NOT_CONNECTED` at 404 is a fact about our data, not about
        // Google being down.
        categoryFor('GOOGLE_CALENDAR_NOT_CONNECTED', 404) === ERROR_CATEGORIES.NOT_FOUND);

    assert('every override names a code that exists in the registry', () =>
        Object.keys(CATEGORY_OVERRIDES).every((code) => code in ERROR_CODES));

    assert('every override carries a non-empty reason', () =>
        Object.values(CATEGORY_OVERRIDES).every((o) => (o?.reason ?? '').length > 20));

    // A dead override is dead policy — the same argument tier-grants.ts makes about a
    // permission granted to no tier. An override that agrees with the rules is either
    // redundant or, worse, a note somebody left after the rules changed underneath it.
    assert('no override merely agrees with what the rules already derive', () => {
        const rows = census();
        const dead: string[] = [];
        for (const code of Object.keys(CATEGORY_OVERRIDES)) {
            const row = rows.get(code);
            if (!row) continue; // no static call site to compare against
            const overridden = CATEGORY_OVERRIDES[code as keyof typeof CATEGORY_OVERRIDES]!.category;
            // Would the rules alone have produced the same answer at every seen status?
            const rulesAgreeEverywhere = [...row.statuses].every((status) => {
                const withoutOverride = fallbackCategory(code, status);
                return withoutOverride === overridden;
            });
            if (rulesAgreeEverywhere) dead.push(code);
        }
        if (dead.length) originalConsole.error(`      dead overrides: ${dead.join(', ')}`);
        return dead.length === 0;
    });

    // ── 3. The census ────────────────────────────────────────────────────────
    section('3. The census — no code may yield two categories');

    const rows = census();

    assert(`the scan found call sites (${rows.size} distinct codes)`, () => rows.size > 100);

    /**
     * Codes already raised at statuses that disagree on category, as of Phase 16.
     *
     * ── This is a RATCHET, not an amnesty ─────────────────────────────────────
     * The census found these on its first run — they are pre-existing status
     * inconsistencies, not something Phase 16 introduced, and every one of them is a real
     * finding. They are baselined rather than fixed because fixing one means changing the
     * status on the wire, which ADR-005 D-1 makes a breaking change to a contract the
     * frontend is already written against. Changing 25 of them in the phase that introduces
     * the taxonomy would be the taxonomy rewriting the API.
     *
     * What the baseline buys: the list cannot GROW. A new code raised at two disagreeing
     * statuses fails this assertion on the commit that introduces it, which is the only
     * moment fixing it is free.
     *
     * ── Four of these straddle the masking boundary and are worth a follow-up ──
     * Category only changes what a client SEES for `internal` and `external_service`. Most
     * of the list is a disagreement between two client-safe categories, where the cost is a
     * wrong label and a wrong support hint. These four are not:
     *
     *   INTERNAL_SERVER_ERROR                      501/500/400/502/409/403/401
     *   ORDER_ITEM_NOT_FOUND                       500/404
     *   DIGITAL_ENTITLEMENT_NOT_FOUND              500/400/404
     *   INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER  400/500
     *
     * `INTERNAL_SERVER_ERROR` is the worst of them and is its own violation: the registry
     * documents it as "assigned by the global handler" and "DO NOT USE IN SERVICES", and it
     * is used at seven different statuses across the service — including 401 and 403, where
     * it describes an authorization outcome as a server fault.
     */
    const KNOWN_STATUS_CONFLICTS: ReadonlySet<string> = new Set([
        'AUTH_USER_NOT_FOUND',
        'AUTH_ACCOUNT_NOT_FOUND',
        'AUTH_OAUTH_STATE_INVALID',
        'AUTH_OAUTH_STATE_EXPIRED',
        'INTERNAL_SERVER_ERROR',
        'DELIVERY_AGENCY_NOT_FOUND',
        'CONTRACT_INVALID_TRANSITION',
        'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING',
        'AGENT_MEMBERSHIP_NOT_APPROVED',
        'CATALOG_DIGITAL_ASSET_ALREADY_EXISTS',
        'CATALOG_PRODUCT_NOT_FOUND',
        'CATALOG_VARIANT_NOT_FOUND',
        'CATALOG_BOOKING_INVALID_PRODUCT_TYPE',
        'CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED',
        'CATALOG_PRODUCT_ACCESS_DENIED',
        'CATALOG_DIGITAL_ASSET_NOT_FOUND',
        'COD_COLLECTION_NOT_COLLECTIBLE',
        'ORDER_ITEM_NOT_FOUND',
        'DIGITAL_ASSET_NOT_FOUND',
        'DIGITAL_ENTITLEMENT_NOT_FOUND',
        'DIGITAL_ENTITLEMENT_EXPIRED',
        'INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER',
        'SHIPMENT_NOT_OFFERABLE',
        'TICKET_ENTITY_NOT_FOUND',
        'VENDOR_CUSTOMER_FLAG_NOT_FOUND',
    ]);

    assert('no NEW code is raised at two statuses that disagree on category', () => {
        const fresh: string[] = [];
        for (const row of rows.values()) {
            if (row.categories.size > 1 && !KNOWN_STATUS_CONFLICTS.has(row.code)) {
                fresh.push(
                    `${row.code}: statuses ${[...row.statuses].join('/')} → ${[...row.categories].join('/')}`,
                );
            }
        }
        if (fresh.length) {
            originalConsole.error('      NEW conflicting codes — pick one status for each:');
            for (const line of fresh) originalConsole.error(`        ${line}`);
        }
        return fresh.length === 0;
    });

    // The ratchet only tightens if the baseline shrinks when somebody fixes one. Without
    // this, a resolved conflict would sit in the list forever and quietly re-admit itself.
    assert('the known-conflict baseline has no stale entries', () => {
        const stillConflicting = new Set(
            [...rows.values()].filter((r) => r.categories.size > 1).map((r) => r.code),
        );
        const stale = [...KNOWN_STATUS_CONFLICTS].filter((code) => !stillConflicting.has(code));
        if (stale.length) {
            originalConsole.error(`      fixed — remove from the baseline: ${stale.join(', ')}`);
        }
        return stale.length === 0;
    });

    // ── 4. Detail policy ─────────────────────────────────────────────────────
    section('4. Detail policy — what a client may see');

    assert('external_service drops details entirely — THE leak this phase exists to close', () =>
        projectDetails(ERROR_CATEGORIES.EXTERNAL_SERVICE, {
            cause: 'connect ECONNREFUSED 10.0.0.7:443 — NotchPay merchant sk_live_xxx rejected',
        }) === undefined);

    assert('internal drops details entirely', () =>
        projectDetails(ERROR_CATEGORIES.INTERNAL, { orderId: 'o1', stack: 'at foo()' }) === undefined);

    assert('validation passes its fields through — they are FOR the client', () => {
        const out = projectDetails(ERROR_CATEGORIES.VALIDATION, {
            fields: [{ path: 'email', message: 'Invalid email', code: 'invalid_string' }],
        });
        return Array.isArray(out?.fields) && (out!.fields as unknown[]).length === 1;
    });

    assert('business_rule keeps its context (the checklist shapes still render)', () => {
        const out = projectDetails(ERROR_CATEGORIES.BUSINESS_RULE, {
            blockers: [{ code: 'CATALOG_NO_PRICE', message: 'Set a price', details: { variant: 'v1' } }],
        });
        return Array.isArray(out?.blockers);
    });

    assert('a `cause` key is dropped even on a client-safe category', () =>
        projectDetails(ERROR_CATEGORIES.CONFLICT, { from: 'a', to: 'b', cause: 'internal narrative' })
            ?.cause === undefined);

    assert('a sensitive field name is dropped, reusing audit/redact.ts’s list', () =>
        projectDetails(ERROR_CATEGORIES.VALIDATION, { email: 'a@b.c', password: 'hunter2' })
            ?.password === undefined);

    assert('authorization keeps `required` and drops `actual` — no role echo', () => {
        const out = projectDetails(ERROR_CATEGORIES.AUTHORIZATION, {
            required: ['vendor'],
            actual: 'customer',
        });
        return out?.required !== undefined && out?.actual === undefined;
    });

    assert('an oversized details payload is replaced, not sent', () => {
        const out = projectDetails(ERROR_CATEGORIES.VALIDATION, { blob: 'x'.repeat(20_000) });
        return out?.truncated === true;
    });

    assert('projectMessage substitutes the registry copy for a masked category', () =>
        projectMessage(
            ERROR_CATEGORIES.INTERNAL,
            'Earnings release underflow on account 66f1c2…',
            DEFAULT_ERROR_MESSAGES[ERROR_CODES.INTERNAL_SERVER_ERROR],
        ) === 'Something went wrong');

    assert('projectMessage leaves a client-safe message alone', () =>
        projectMessage(ERROR_CATEGORIES.BUSINESS_RULE, 'The agent is at their agency cap', 'x')
            === 'The agent is at their agency cap');

    // ── 5. The envelope ──────────────────────────────────────────────────────
    section('5. The envelope — the real handler, rendered');

    assert('shape is unchanged and `category` is present', () => {
        const out = render(createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404));
        return out.status === 404
            && out.body.success === false
            && out.body.requestId === 'req_test'
            && out.body.error.code === 'ORDER_NOT_FOUND'
            && out.body.error.statusCode === 404
            && out.body.error.category === 'not_found';
    });

    assert('details is OMITTED when there is none — never null, never {}', () => {
        const out = render(createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404));
        return !('details' in out.body.error);
    });

    assert('a stack is never sent, on any branch', () => {
        const out = render(new Error('boom'));
        return !JSON.stringify(out.body).includes('at ') && !('stack' in out.body.error);
    });

    assert('the payment-orchestrator `{ cause }` leak is closed end to end', () => {
        const out = render(createAppError(
            ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined,
            { cause: 'Request failed with status code 401: {"message":"Invalid API key sk_live_…"}' },
        ));
        const serialised = JSON.stringify(out.body);
        return out.body.error.category === 'external_service'
            && !('details' in out.body.error)
            && !serialised.includes('sk_live_')
            && !serialised.includes('Invalid API key');
    });

    // The single most important regression test in this file. A masking rule that only
    // runs in production is a rule nobody has ever watched work.
    assert('production and development render an `internal` error IDENTICALLY', () => {
        const err = createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings underflow on 66f1');
        const prod = renderUnder('production', err);
        const dev = renderUnder('development', err);
        return JSON.stringify(prod.body) === JSON.stringify(dev.body)
            && prod.body.error.message === 'Something went wrong';
    });

    assert('an unknown Error is a masked 500 in development too', () => {
        const out = renderUnder('development', new Error('mongo: no reachable servers'));
        return out.status === 500
            && out.body.error.category === 'internal'
            && !JSON.stringify(out.body).includes('mongo');
    });

    assert('a ZodError is 400 VALIDATION_ERROR with per-field details', () => {
        let zodErr: ZodError | null = null;
        try {
            z.object({ email: z.string().email() }).parse({ email: 'nope' });
        } catch (e) {
            zodErr = e as ZodError;
        }
        const out = render(zodErr);
        const fields = out.body.error.details?.fields as Array<{ path: string }> | undefined;
        return out.status === 400
            && out.body.error.code === 'VALIDATION_ERROR'
            && out.body.error.category === 'validation'
            && fields?.[0]?.path === 'email';
    });

    assert('a duplicate key is 409 conflict and still names the colliding field', () => {
        const out = render(Object.assign(new Error('dup'), { code: 11000, keyValue: { email: 'a@b.c' } }));
        return out.status === 409
            && out.body.error.category === 'conflict'
            && (out.body.error.details?.keyValue as Record<string, string>)?.email === 'a@b.c';
    });

    assert('a Mongoose CastError is 404, not 500', () => {
        const out = render(Object.assign(new Error('cast'), { name: 'CastError' }));
        return out.status === 404 && out.body.error.category === 'not_found';
    });

    assert('isOperational is derived — a 500 through the factory is NOT operational', () => {
        const err = createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500);
        const ok = createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        return err.isOperational === false && ok.isOperational === true;
    });

    assert('an explicit isOperational still wins (ticket.service.ts passes false)', () =>
        new AppError('x', 500, ERROR_CODES.TICKET_UPDATE_FAILED, false).isOperational === false);

    assert('every AppError carries a category, including a subclass built via super()', () =>
        new AppError('x', 409, ERROR_CODES.SHIPMENT_STATUS_CONFLICT).category === 'conflict');

    // ── 6. Body parser ───────────────────────────────────────────────────────
    section('6. Body-parser rejections — the branch that did not exist');

    assert('malformed JSON is 400 REQUEST_BODY_INVALID, not 500', () => {
        const out = render(Object.assign(new SyntaxError('Unexpected token'), {
            type: 'entity.parse.failed', status: 400,
        }));
        return out.status === 400 && out.body.error.code === 'REQUEST_BODY_INVALID';
    });

    assert('an oversized body is 413 REQUEST_BODY_TOO_LARGE', () => {
        const out = render(Object.assign(new Error('too large'), {
            type: 'entity.too.large', status: 413,
        }));
        return out.status === 413 && out.body.error.code === 'REQUEST_BODY_TOO_LARGE';
    });

    assert('a bad charset is 415 REQUEST_MEDIA_TYPE_UNSUPPORTED', () => {
        const out = render(Object.assign(new Error('bad charset'), {
            type: 'charset.unsupported', status: 415,
        }));
        return out.status === 415 && out.body.error.code === 'REQUEST_MEDIA_TYPE_UNSUPPORTED';
    });

    assert('a 5xx-tagged body-parser fault stays OURS (falls through to the 500 branch)', () =>
        classifyBodyParserFailure({ type: 'entity.verify.failed', status: 500 }) === null);

    assert('a plain Error is not mistaken for a body-parser rejection', () =>
        classifyBodyParserFailure(new Error('nope')) === null);

    assert('an object that merely has type+status is not mistaken for one', () =>
        classifyBodyParserFailure({ type: 'user', status: 400 }) === null);

    // ── 7. Rate limiting ─────────────────────────────────────────────────────
    section('7. Rate-limit policy — totality, ordering, exemptions');

    assert('every policy has a ceiling for every caller class', () =>
        POLICIES.every((policy) => CALLER_CLASSES.every((c) => ceilingFor(policy, c) !== undefined)));

    assert('internal service callers are exempt from the two volume policies', () =>
        ceilingFor(GLOBAL_POLICY, 'internal_service') === 'exempt'
        && ceilingFor(IDENTITY_POLICY, 'internal_service') === 'exempt');

    // Nothing internal logs in, so an exemption on the credential bucket could only ever be
    // used by something that had already stolen the service token.
    assert('internal service callers are NOT exempt from the credential bucket', () =>
        ceilingFor(AUTH_POLICY, 'internal_service') !== 'exempt');

    assert('the credential bucket is far stricter than every volume ceiling', () => {
        const auth = ceilingFor(AUTH_POLICY, 'anonymous') as number;
        return CALLER_CLASSES.filter((c) => c !== 'internal_service').every(
            (c) => auth < (ceilingFor(IDENTITY_POLICY, c) as number),
        );
    });

    assert('Layer A sits above every identity ceiling, so it only catches floods', () => {
        const layerA = ceilingFor(GLOBAL_POLICY, 'anonymous') as number;
        return CALLER_CLASSES.filter((c) => c !== 'internal_service').every(
            (c) => layerA >= (ceilingFor(IDENTITY_POLICY, c) as number),
        );
    });

    assert('agent and admin get the most generous identity ceilings', () => {
        const agent = ceilingFor(IDENTITY_POLICY, 'agent') as number;
        const customer = ceilingFor(IDENTITY_POLICY, 'customer') as number;
        const vendor = ceilingFor(IDENTITY_POLICY, 'vendor') as number;
        return agent > vendor && vendor > customer;
    });

    // ADR-014 D-1: a 429 here pulls geo-tracker out of rotation and kills every live
    // tracking session, for load on a service that is itself healthy.
    assert('the FROZEN health contract is exempt, including /live and /ready', () =>
        isExemptPathname('/api/health')
        && isExemptPathname('/api/health/live')
        && isExemptPathname('/api/health/ready'));

    assert('metrics and gateway webhooks are exempt', () =>
        isExemptPathname('/metrics') && isExemptPathname('/api/webhooks/stripe'));

    assert('the exemption is anchored — a lookalike path does NOT inherit it', () =>
        !isExemptPathname('/api/healthcheck-bypass') && !isExemptPathname('/api/webhooksX'));

    assert('business routes are not exempt', () =>
        !isExemptPathname('/api/orders') && !isExemptPathname('/api/auth/login'));

    assert('every exemption carries a written reason', () =>
        EXEMPT_PATHS.every((e) => e.reason.length > 40));

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();

/**
 * What `categoryFor` would return for this code if the override table were empty.
 *
 * Used only by the dead-override check. Kept as a small duplicate of the two lower tiers
 * rather than exported from the module, because exporting a "pretend the policy is not
 * there" entry point invites somebody to call it in earnest.
 */
function fallbackCategory(code: string, status: number): ErrorCategory {
    const integrationPrefixes = [
        'STRIPE_', 'GOOGLE_', 'WHATSAPP_', 'TELEGRAM_', 'STORAGE_', 'GEO_', 'MAIL_',
        'NOTCHPAY_', 'MYCOOLPAY_',
    ];
    if (status >= 500 && integrationPrefixes.some((p) => code.startsWith(p))) {
        return ERROR_CATEGORIES.EXTERNAL_SERVICE;
    }
    const table: Record<number, ErrorCategory> = {
        400: ERROR_CATEGORIES.VALIDATION,
        401: ERROR_CATEGORIES.AUTHENTICATION,
        403: ERROR_CATEGORIES.AUTHORIZATION,
        404: ERROR_CATEGORIES.NOT_FOUND,
        409: ERROR_CATEGORIES.CONFLICT,
        410: ERROR_CATEGORIES.NOT_FOUND,
        413: ERROR_CATEGORIES.VALIDATION,
        415: ERROR_CATEGORIES.VALIDATION,
        422: ERROR_CATEGORIES.BUSINESS_RULE,
        423: ERROR_CATEGORIES.BUSINESS_RULE,
        429: ERROR_CATEGORIES.RATE_LIMIT,
        502: ERROR_CATEGORIES.EXTERNAL_SERVICE,
        503: ERROR_CATEGORIES.EXTERNAL_SERVICE,
        504: ERROR_CATEGORIES.EXTERNAL_SERVICE,
    };
    if (table[status]) return table[status];
    if (status >= 400 && status < 500) return ERROR_CATEGORIES.BUSINESS_RULE;
    return ERROR_CATEGORIES.INTERNAL;
}
