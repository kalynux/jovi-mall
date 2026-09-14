/**
 * Test: the system-operations surface's pure parts.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free throughout: every subject here was deliberately extracted off the I/O path so it
 * could be driven with literals.
 *
 * Six sections, and each exists because of something that was actually wrong or could quietly
 * go wrong:
 *
 *   1. Worker schedules      the registry's hand-typed strings were wrong for 8 of 10 workers.
 *                            This asserts the reported value IS the value the worker schedules
 *                            with, so retyping a literal fails here rather than misleading an
 *                            operator during an incident.
 *   2. Maintenance           drives the whole exemption table, including the two entries whose
 *                            omission would take geo-tracker down with us and the one whose
 *                            omission locks the operator out of their own exit.
 *   3. Cache-flush policy    every refusal path, plus the assertion that a new Redis database
 *                            cannot be added without a policy row.
 *   4. Route groups          PROVES boundedness by fuzzing rather than asserting the happy path.
 *   5. Redis catalog         the catalog and the factory constants cannot drift.
 *   6. Metric hygiene        nothing reached prom-client's global registry.
 *
 * What this cannot cover, and why the endpoints still need a live check: that Mongo answers
 * `serverStatus` on the deployment you are on, that `INFO keyspace` parses against a real Redis,
 * and that the maintenance middleware is mounted where `app.ts` thinks it is. Boot the server.
 *
 * Run: npm run test:system
 */
import { register as globalRegister } from 'prom-client';
import {
    REDIS_DB_CATALOG,
    WORKER_LOCK_DB,
    EMAIL_VERIFY_DB,
    WA_IDEMPOTENCY_DB,
    WA_WINDOW_DB,
    SLOT_LOCK_DB,
    DOWNLOAD_TOKEN_DB,
    BOT_SURFACE_DB,
    RATE_LIMIT_DB,
    CONNECTION_CODE_DB,
    LOGIN_CODE_DB,
    CACHE_DB,
} from '../../src/infra/redis/redis.factory';
import { describeSchedule, WorkerSchedule } from '../../src/core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED, __resetWorkerLocksForTest } from '../../src/core/jobs/worker-lock';
import { WORKER_INVENTORY, WORKER_KEYS, WORKER_REGISTRY } from '../../src/modules/dev-tools/worker-registry';
import {
    MaintenanceState,
    MAINTENANCE_OFF,
    effectiveMode,
    evaluateMaintenance,
    blocksWorkers,
} from '../../src/modules/system/domain/maintenance-mode';
import {
    CACHE_FLUSH_POLICY,
    resolveFlushPlan,
    policyFor,
} from '../../src/modules/system/domain/cache-flush-policy';
import { ROUTE_GROUPS, MAX_ROUTE_GROUPS, routeGroup, statusClass } from '../../src/modules/system/domain/route-group';
import {
    httpRequestDuration,
    initializeMetrics,
    integrationDuration,
    metricsRegistry,
    workerDuration,
} from '../../src/modules/system/metrics/metrics';
import { scrubText, truncateMessage, SCRUBBED_FIELD_NAMES } from '../../src/core/logging/scrub';
import { LogRingBuffer } from '../../src/core/logging/ring-buffer';
import type { LogRecord } from '../../src/core/logging/log-record';
import { REDACTED_PATHS, logRing, __resetLoggerForTests } from '../../src/core/logging/logger';
import { __resetLoggingConfigForTests } from '../../src/core/logging/logging.config';
import {
    BRIDGED_METHODS,
    installConsoleBridge,
    isConsoleBridgeInstalled,
    uninstallConsoleBridge,
} from '../../src/core/logging/console-bridge';
import { originalConsole, runInSink, suppressedSinkCalls } from '../../src/core/logging/sink-guard';
import { runWithRequestContext } from '../../src/core/logging/request-context';
import { logMongoSink } from '../../src/core/logging/mongo-sink';
import { initLogging } from '../../src/core/logging';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import {
    EXPOSED_CONFIG_KEYS,
    FORBIDDEN_CONFIG_TOKEN,
    assertExposedConfigSafe,
    configWiring,
    exposedConfig,
} from '../../src/modules/system/domain/exposed-config';
import { resolveInspectPlan } from '../../src/modules/system/domain/cache-flush-policy';
import { REDIS_READ_COMMANDS, isRedisReadCommand } from '../../src/modules/system/domain/redis-command-policy';
import { diffIndexes, normaliseIndex } from '../../src/modules/system/domain/index-diff';
import { resolvePrunePlan } from '../../src/modules/system/domain/outbox-prune-policy';
import { DatabaseInspectQuerySchema, LogQuerySchema } from '../../src/modules/system/validators/system.validator';
import { healthRoutes } from '../../src/api/routes/health.routes';
import { isExemptPathname } from '../../src/api/rate-limit/exempt-paths';
import {
    resolveMigrationStatus,
    needsApplying,
} from '../../src/core/database/schema-migration.model';
// Safe to import: `scripts/migrate.ts` guards its own `main()` behind `require.main === module`,
// so this reaches the registry without applying anything. See that file's tail.
import { MIGRATIONS, assertRegistryCovers } from '../migrate';
type RequestHandlerLike = (req: never, res: never, next: never) => void;

let passed = 0;
let failed = 0;

/**
 * The harness prints through `originalConsole`, NOT through `console`.
 *
 * §9 installs the console bridge, which reroutes `console.*` into the logger — and with the
 * primary stream off, straight into the ring buffer. A harness printing through `console` would
 * therefore have its own results swallowed by the code it is testing: the assertions still run
 * and still count, but the section comes out blank and a failure is invisible. That is exactly
 * what happened the first time this ran.
 */
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
        originalConsole.log(`  ✅ ${name}`);
        passed++;
    } else {
        originalConsole.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

// ═══ 1. Worker schedules ══════════════════════════════════════════════════════

section('Worker schedules — derived, never typed');

assert('every triggerable worker is in the inventory', () =>
    WORKER_KEYS.every((key) => WORKER_INVENTORY.some((entry) => entry.key === key)));

assert('every triggerable entry has a runOnce', () =>
    WORKER_KEYS.every((key) => typeof WORKER_REGISTRY[key].runOnce === 'function'));

assert('the inventory carries more than the triggerable set (calendar sync is observable but not runnable)', () =>
    WORKER_INVENTORY.length > WORKER_KEYS.length
    && WORKER_INVENTORY.some((e) => !e.triggerable && e.notTriggerableReason !== null));

assert('assignment-sweep is triggerable — it was missing from the registry entirely', () =>
    WORKER_KEYS.includes('assignment-sweep' as never));

assert('every worker reports at least one schedule', () =>
    WORKER_INVENTORY.every((entry) => entry.worker.schedules.length >= 1));

/**
 * The assertion that actually prevents the original defect.
 *
 * Not "the string looks plausible" — the reported expression must be the SAME VALUE the worker
 * hands to `cron.schedule` / `setInterval`. Reading it back off the worker means a literal
 * retyped into the registry has nowhere to hide.
 */
assert('every cron schedule is a real 5-field expression, and every interval a positive number', () =>
    WORKER_INVENTORY.every((entry) =>
        entry.worker.schedules.every((s: WorkerSchedule) =>
            s.kind === 'cron'
                ? s.expression.trim().split(/\s+/).length === 5
                : Number.isFinite(s.everyMs) && s.everyMs > 0)));

assert('every schedule names where it came from (env var or "hardcoded")', () =>
    WORKER_INVENTORY.every((entry) => entry.worker.schedules.every((s) => s.source.length > 0)));

assert('the calendar sync worker reports BOTH its intervals', () => {
    const entry = WORKER_INVENTORY.find((e) => e.key === 'inbound-calendar-sync');
    return entry !== undefined && entry.worker.schedules.length === 2;
});

section('describeSchedule — renders what it knows, echoes what it does not');

assert('daily at a fixed time', () =>
    describeSchedule({ kind: 'cron', expression: '0 3 * * *', source: 'x' }) === 'daily at 03:00');

assert('daily at a half-hour', () =>
    describeSchedule({ kind: 'cron', expression: '30 3 * * *', source: 'x' }) === 'daily at 03:30');

assert('hourly at a fixed minute', () =>
    describeSchedule({ kind: 'cron', expression: '15 * * * *', source: 'x' }) === 'hourly at :15');

assert('every-n-minutes', () =>
    describeSchedule({ kind: 'cron', expression: '*/10 * * * *', source: 'x' }) === 'every 10 minutes');

assert('weekly names the day', () =>
    describeSchedule({ kind: 'cron', expression: '0 4 * * 1', source: 'x' }) === 'weekly on Monday at 04:00');

assert('intervals render in the largest whole unit', () =>
    describeSchedule({ kind: 'interval', everyMs: 900_000, source: 'x' }) === 'every 15 minute(s)'
    && describeSchedule({ kind: 'interval', everyMs: 2_000, source: 'x' }) === 'every 2 second(s)');

/**
 * The load-bearing property, and the reason this function exists at all: the defect being
 * prevented was a confident English sentence that disagreed with the machine-readable truth
 * beside it. A renderer that guesses at a pattern it does not understand recreates that bug.
 */
assert('an unsupported cron pattern is ECHOED, never guessed at', () =>
    describeSchedule({ kind: 'cron', expression: '0 3 1-5 * *', source: 'x' }) === '0 3 1-5 * *'
    && describeSchedule({ kind: 'cron', expression: 'nonsense', source: 'x' }) === 'nonsense');

// ═══ 2. Maintenance mode ══════════════════════════════════════════════════════

section('Maintenance — the exemption table');

function state(overrides: Partial<MaintenanceState> = {}): MaintenanceState {
    return {
        ...MAINTENANCE_OFF,
        mode: 'down',
        reason: 'migration in progress',
        startedAt: new Date('2026-08-12T10:00:00Z'),
        ...overrides,
    };
}

const NOW = new Date('2026-08-12T10:05:00Z');
const allowed = (s: MaintenanceState, method: string, path: string) =>
    evaluateMaintenance(s, NOW, method, path).allowed;

assert('off allows everything', () =>
    allowed(MAINTENANCE_OFF, 'POST', '/api/customer/orders'));

// The four exemptions whose absence would be expensive, each asserted in `down` — the strictest
// mode — because an exemption that only holds in `readonly` is not an exemption.
assert('DOWN still allows /api/health', () => allowed(state(), 'GET', '/api/health'));
assert('DOWN still allows /api/health/ready', () => allowed(state(), 'GET', '/api/health/ready'));

assert('DOWN still allows /api/internal/admin/* — the operator exit', () =>
    allowed(state(), 'PUT', '/api/internal/admin/dev-tools/maintenance')
    && allowed(state(), 'GET', '/api/internal/admin/system/queues'));

assert('DOWN still allows /api/internal/agents/* — blocking it drops every geo-tracker watcher', () =>
    allowed(state(), 'GET', '/api/internal/agents/abc/eligibility'));

assert('DOWN still allows /api/tracking/* — read-only visibility policy', () =>
    allowed(state(), 'GET', '/api/tracking/visible-agents'));

assert('readonly allows reads and refuses writes', () =>
    allowed(state({ mode: 'readonly' }), 'GET', '/api/products')
    && !allowed(state({ mode: 'readonly' }), 'POST', '/api/customer/orders'));

assert('down refuses reads too', () => !allowed(state(), 'GET', '/api/products'));

/**
 * ── Restated at the Phase 5 cutover, because its subject no longer exists ────
 *
 * This read `'/api/admin/* is NOT exempt — an admin with a users row is still a user'`, and it
 * was the right assertion while jovi-mall served a public admin surface: an operator holding a
 * legacy `admin` role got no maintenance bypass from it. **Part E deleted that prefix**, so the
 * check would now pass because nothing is routed there — vacuously green, catching nothing.
 *
 * The fact that replaces it is the one that actually matters and was asserted NOWHERE:
 * **`/api/internal/admin` IS exempt, in every mode, unconditionally.** It is the first entry in
 * `ALWAYS_EXEMPT`, and it has to be, because it is the door an operator uses to turn maintenance
 * OFF — `/system/*` tells them when it is safe to exit and `/dev-tools/*` is the switch. An
 * exemption that a maintenance window could remove would lock the operator out of their own
 * recovery.
 *
 * Both modes are asserted, and a WRITE is used deliberately: `readonly` refusing writes is the
 * rule this exemption has to survive, so testing it with a GET would prove nothing.
 */
assert('/api/internal/admin IS exempt in DOWN — it is the door that turns maintenance off', () =>
    allowed(state(), 'POST', '/api/internal/admin/dev-tools/maintenance')
    && allowed(state(), 'GET', '/api/internal/admin/system/health'));

assert('…and in READONLY, including writes', () =>
    allowed(state({ mode: 'readonly' }), 'POST', '/api/internal/admin/cod/settlements'));

section('Maintenance — the webhook trade');

assert('webhooks are allowed in BOTH modes by default', () =>
    allowed(state({ mode: 'readonly' }), 'POST', '/api/webhooks/stripe')
    && allowed(state(), 'POST', '/api/webhooks/stripe'));

assert('blockWebhooks:true closes them — the per-incident override', () =>
    !allowed(state({ blockWebhooks: true }), 'POST', '/api/webhooks/stripe'));

assert('blockWebhooks does not affect the always-exempt prefixes', () =>
    allowed(state({ blockWebhooks: true }), 'GET', '/api/health')
    && allowed(state({ blockWebhooks: true }), 'GET', '/api/internal/admin/system/cache'));

assert('a download in flight survives readonly but not down', () =>
    allowed(state({ mode: 'readonly' }), 'GET', '/api/digital/download/tok')
    && !allowed(state(), 'GET', '/api/digital/download/tok'));

// Same shape, same reason: nominally a POST, writes nothing. A browser and the Flutter agent
// app both renew inside a GET via `requireAuth`'s silent refresh, so they ride out a read-only
// window; a bearer client has no such path and this route is its only one, so blocking it
// signs out every native client fifteen minutes in.
assert('a bearer session can be renewed in readonly but not in down', () =>
    allowed(state({ mode: 'readonly' }), 'POST', '/api/auth/mobile/refresh')
    && !allowed(state(), 'POST', '/api/auth/mobile/refresh'));

assert('…and that is one route, not a pass for the whole /api/auth prefix', () =>
    !allowed(state({ mode: 'readonly' }), 'POST', '/api/auth/login')
    && !allowed(state({ mode: 'readonly' }), 'POST', '/api/auth/browser/login'));

section('Maintenance — every unknown fails OPEN');

assert('an elapsed expires_at reads as off, with no write', () =>
    effectiveMode(state({ expiresAt: new Date('2026-08-12T10:01:00Z') }), NOW) === 'off');

assert('a future expires_at keeps the window', () =>
    effectiveMode(state({ expiresAt: new Date('2026-08-12T11:00:00Z') }), NOW) === 'down');

/**
 * Fail OPEN, deliberately. A corrupt document must not produce an outage nobody can exit —
 * the failure mode of failing closed here is a platform that is down and whose own operator
 * door may be part of what is down.
 */
assert('an unknown mode reads as off', () =>
    effectiveMode(state({ mode: 'sideways' as never }), NOW) === 'off');

assert('prefix matching respects segment boundaries', () =>
    // Without this, naming a route `/api/healthcheck-bypass` would exempt itself.
    !allowed(state(), 'GET', '/api/healthcheck-bypass')
    && !allowed(state(), 'GET', '/api/internal/administrators'));

section('Maintenance — worker pausing');

assert('readonly does NOT pause workers by default', () =>
    !blocksWorkers(state({ mode: 'readonly', pauseWorkers: false }), NOW));

assert('down pauses when pauseWorkers is set', () =>
    blocksWorkers(state({ pauseWorkers: true }), NOW));

assert('an expired window pauses nothing', () =>
    !blocksWorkers(state({ pauseWorkers: true, expiresAt: new Date('2026-08-12T10:01:00Z') }), NOW));

// ═══ 3. Cache-flush policy ════════════════════════════════════════════════════

section('Cache flush — refusals');

const MAX_KEYS = 1000;
const plan = (input: Parameters<typeof resolveFlushPlan>[0]) => resolveFlushPlan(input, MAX_KEYS);

assert('an unknown database name is refused', () => {
    const result = plan({ db: 'NOPE_DB', confirm: 'NOPE_DB' });
    return !result.ok && result.code === 'unknown_db';
});

assert('confirm must repeat the database name', () => {
    const result = plan({ db: 'EMAIL_VERIFY_DB', confirm: 'SLOT_LOCK_DB' });
    return !result.ok && result.code === 'confirmation_mismatch';
});

assert('the three prefix-only destructive databases refuse a whole-database flush', () =>
    (['WA_IDEMPOTENCY_DB', 'SLOT_LOCK_DB', 'DOWNLOAD_TOKEN_DB'] as const).every((db) => {
        const result = plan({ db, confirm: db });
        return !result.ok && result.code === 'whole_db_not_allowed';
    }));

assert('the same three ACCEPT a prefixed flush', () =>
    (['WA_IDEMPOTENCY_DB', 'SLOT_LOCK_DB', 'DOWNLOAD_TOKEN_DB'] as const).every((db) =>
        plan({ db, confirm: db, prefix: 'slot:' }).ok));

/**
 * WORKER_LOCK_DB is the one destructive database that PERMITS a whole-database flush, and the
 * exception is pinned here so it reads as a decision. An operator facing an orphaned sweep lock
 * does not know which worker owns it — that is the symptom — so a prefix-only rule would make the
 * remedy unreachable. It still carries `destructive: true`, so the warning and the audit row say
 * what releasing every lock costs.
 */
assert('WORKER_LOCK_DB is destructive AND whole-DB flushable — the deliberate exception', () => {
    const result = plan({ db: 'WORKER_LOCK_DB', confirm: 'WORKER_LOCK_DB' });
    return result.ok && result.destructive && result.blastRadius.includes('DESTRUCTIVE');
});

/**
 * A prefix of `*` is a whole-database flush wearing a prefix's clothes — it would sail straight
 * past the rule above. Refused explicitly rather than escaped into a literal asterisk, because
 * escaping it would return zero matches and look like success.
 */
assert('a prefix of "*" is refused outright', () => {
    const result = plan({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB', prefix: '*' });
    return !result.ok && result.code === 'invalid_prefix';
});

section('Cache flush — plan construction');

assert('glob metacharacters in a prefix are escaped', () => {
    const result = plan({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB', prefix: 'a*b?c[d]' });
    return result.ok && result.match === 'a\\*b\\?c\\[d\\]*';
});

assert('we append the wildcard — the caller never supplies a pattern', () => {
    const result = plan({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB', prefix: 'slot:' });
    return result.ok && result.match === 'slot:*';
});

assert('limit is clamped to the configured ceiling', () => {
    const result = plan({ db: 'EMAIL_VERIFY_DB', confirm: 'EMAIL_VERIFY_DB', limit: 999_999 });
    return result.ok && result.limit === MAX_KEYS;
});

assert('dryRun defaults to TRUE — an operator has to ask twice', () => {
    const result = plan({ db: 'EMAIL_VERIFY_DB', confirm: 'EMAIL_VERIFY_DB' });
    return result.ok && result.dryRun === true;
});

assert('dryRun:false is honoured', () => {
    const result = plan({ db: 'EMAIL_VERIFY_DB', confirm: 'EMAIL_VERIFY_DB', dryRun: false });
    return result.ok && result.dryRun === false;
});

assert('every plan carries its blast radius, so it reaches the audit row', () => {
    const result = plan({ db: 'SLOT_LOCK_DB', confirm: 'SLOT_LOCK_DB', prefix: 'slot:' });
    return result.ok && result.blastRadius.includes('DEGRADED, NOT BROKEN') && result.destructive;
});

/**
 * The important one. A logical database added to the factory without a policy row would
 * otherwise be silently unflushable — or, if somebody later made the lookup permissive,
 * silently flushable with no stated blast radius.
 */
assert('EVERY catalogued Redis database has a flush policy row', () =>
    REDIS_DB_CATALOG.every((spec) => policyFor(spec.constant) !== null));

assert('database 0 has no policy row and cannot be named', () =>
    CACHE_FLUSH_POLICY.every((row) => row.spec.db !== 0)
    && !plan({ db: '0', confirm: '0' }).ok);

// ═══ 4. Route groups ══════════════════════════════════════════════════════════

section('Route groups — bounded, not merely normalised');

assert('an ObjectId segment collapses', () =>
    routeGroup('/api/vendor/products/507f1f77bcf86cd799439011') === '/api/vendor/products');

assert('a UUID segment collapses', () =>
    routeGroup('/api/customer/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301') === '/api/customer/orders');

assert('a numeric segment collapses', () => routeGroup('/api/products/12345') === '/api/products');

assert('the longest mounted prefix wins over a shorter one', () =>
    routeGroup('/api/vendor/products/abc') === '/api/vendor/products'
    && routeGroup('/api/vendor/anything-else') === '/api/vendor');

assert('probes and the scrape get their own groups rather than being dropped', () =>
    routeGroup('/api/health/ready') === '/api/health' && routeGroup('/metrics') === '/metrics');

assert('an unknown prefix becomes "other"', () =>
    routeGroup('/api/wp-admin') === 'other'
    && routeGroup('/api/.env') === 'other'
    && routeGroup('/nonsense') === 'other');

assert('the allowlist is under the cardinality cap', () => ROUTE_GROUPS.length <= MAX_ROUTE_GROUPS);

/**
 * The assertion that PROVES boundedness rather than sampling it.
 *
 * prom-client enforces no per-metric cardinality cap, so this allowlist IS the cap. A thousand
 * adversarial paths — the shape a scanner produces — must not mint a thousand label values.
 */
assert('1000 adversarial paths yield no more labels than the allowlist holds', () => {
    const labels = new Set<string>();
    for (let i = 0; i < 1000; i++) {
        labels.add(routeGroup(`/api/${Math.random().toString(36).slice(2)}/${i}`));
        labels.add(routeGroup(`/${Math.random().toString(36).slice(2)}`));
        labels.add(routeGroup(`/api/vendor/products/${Math.random().toString(36).slice(2)}`));
    }
    return labels.size <= ROUTE_GROUPS.length;
});

assert('deep paths truncate instead of growing the label space', () =>
    routeGroup('/api/vendor/products/a/b/c/d/e/f/g') === '/api/vendor/products');

assert('status classes collapse to five values', () =>
    statusClass(200) === '2xx' && statusClass(404) === '4xx'
    && statusClass(503) === '5xx' && statusClass(0) === 'other');

// ═══ 5. Redis catalog ═════════════════════════════════════════════════════════

section('Redis catalog — cannot drift from the factory constants');

assert('every exported *_DB constant appears exactly once in the catalog', () => {
    // WA_VERIFY_DB (4) and TELEGRAM_LINK_TOKEN_DB (9) were RETIRED with the two
    // account-linking mechanisms they served; CONNECTION_CODE_DB (13) replaces both.
    // 4 and 9 are deliberately left unassigned — see the factory's note.
    //
    // LOGIN_CODE_DB (14) is separate from 13 rather than a prefix on it: the flush
    // policy states consequences per DATABASE, and "in-flight sign-ins fail" is not
    // "in-flight connections fail".
    //
    // ⚠ TWO databases hold TWO THINGS EACH behind key prefixes, and both pairings are a
    // CONCESSION rather than the rule — see the factory's note above the catalogue. The
    // rule is one database per blast radius; what forced the concession is that this
    // service may only assign 5–15 (Redis's ceiling of 16, minus the low indices wi-admin
    // claims on a shared instance), which is eleven slots for thirteen things.
    //
    //   BOT_SURFACE_DB (10)  `bot:idem:` + `bot:geo:`   — was TELEGRAM_WINDOW_DB, which was
    //                        reserved for a 24-hour window the Telegram Bot API does not
    //                        have and was therefore never written to by anything.
    //   CACHE_DB (15)        `geo:` + `related:`        — was GEO_CACHE_DB; `related:` came
    //                        off the invalid DB 16, where its cache had never once run.
    //
    // What keeps the concession honest is that the flush endpoint takes a PREFIX, so each
    // half stays independently clearable and each policy row states both radii rather than
    // averaging them. `BOT_SURFACE_DB` is prefix-only for exactly that reason.
    const exported = [
        EMAIL_VERIFY_DB, WA_IDEMPOTENCY_DB, WA_WINDOW_DB,
        SLOT_LOCK_DB, DOWNLOAD_TOKEN_DB, BOT_SURFACE_DB,
        RATE_LIMIT_DB, WORKER_LOCK_DB, CONNECTION_CODE_DB, LOGIN_CODE_DB,
        CACHE_DB,
    ];
    return exported.every((db) => REDIS_DB_CATALOG.filter((row) => row.db === db).length === 1)
        && REDIS_DB_CATALOG.length === exported.length;
});

/**
 * ⛔ Redis's `databases` defaults to 16, so the only valid indices are 0–15.
 *
 * Measured 2026-08-25 on the development Redis (`CONFIG GET databases` → 16, `SELECT 16` →
 * `ERR invalid DB index`, and `CONFIG SET databases 32` → `ERR Unsupported CONFIG parameter`,
 * because it is startup-only) and true of the compose stack, whose `redis:7-alpine` services
 * carry no `command:` override. An index above the ceiling does not fail loudly: the
 * connection opens, the `SELECT` errors, and callers that fail open — which the caches
 * correctly do — degrade to "never cached" with no symptom at all. That is exactly what had
 * happened to `RECOMMENDATION_CACHE_DB = 16`, whose cache had never run since 2026-08-21.
 *
 * The baseline is EMPTY now, and it should stay empty: everything is in range.
 */
const REDIS_DB_CEILING = 16;

assert('no logical database is above the Redis default ceiling (0-15)', () => {
    const over = REDIS_DB_CATALOG
        .filter((row) => row.db >= REDIS_DB_CEILING)
        .map((row) => `${row.constant}=${row.db}`);
    if (over.length) console.error('     ↳ unreachable on a stock Redis:', over.join(', '));
    return over.length === 0;
});

/**
 * ⚠ And 0–4 are not this service's to assign either, whatever this file says about them.
 *
 * `wi-admin` claims `ADMIN_SESSION_DB = 1`, `ADMIN_RATE_LIMIT_DB = 2` and
 * `PERMISSION_CACHE_DB = 3` on the SAME Redis whenever the two services share one — which the
 * compose stack avoids by giving each its own instance, and which a developer machine does
 * not: both `.env` files point at `redis://localhost:6379`. DB 0 additionally holds
 * `InboundCalendarSyncService`'s per-vendor lock.
 *
 * `EMAIL_VERIFY_DB = 3` is a KNOWN, pre-existing collision with wi-admin's permission cache
 * and is baselined here rather than moved: nothing reads the other's keys (both are exact
 * gets), and moving it would invalidate every verification link in flight for a problem the
 * separate-instance deployment already solves. Anything NEW below 5 is a mistake this catches.
 */
const CROSS_SERVICE_RESERVED = 5;
const KNOWN_LOW_INDEX = ['EMAIL_VERIFY_DB'];

assert('nothing new is assigned below 5, where wi-admin and DB 0 already live', () => {
    const low = REDIS_DB_CATALOG
        .filter((row) => row.db < CROSS_SERVICE_RESERVED)
        .filter((row) => !KNOWN_LOW_INDEX.includes(row.constant))
        .map((row) => `${row.constant}=${row.db}`);
    if (low.length) console.error('     ↳ collides with wi-admin or DB 0:', low.join(', '));
    return low.length === 0;
});

assert('the low-index baseline has no stale entries', () =>
    KNOWN_LOW_INDEX.every((constant) =>
        REDIS_DB_CATALOG.some((row) => row.constant === constant && row.db < CROSS_SERVICE_RESERVED)));

assert('no two catalog rows share an index', () =>
    new Set(REDIS_DB_CATALOG.map((row) => row.db)).size === REDIS_DB_CATALOG.length);

assert('no two catalog rows share a constant name', () =>
    new Set(REDIS_DB_CATALOG.map((row) => row.constant)).size === REDIS_DB_CATALOG.length);

assert('every row states what is lost when its keys go', () =>
    REDIS_DB_CATALOG.every((row) => row.purpose.length > 10));

// ═══ 6. Metric hygiene ════════════════════════════════════════════════════════

section('Metrics — a private registry, and it stays private');

// The real boot path, so this section also proves `assertRouteGroupsBounded()` passes and the
// default-metrics collection lands on the private registry rather than the global one.
initializeMetrics();

assert('the registry exists', () => metricsRegistry() !== null);

/**
 * geo-tracker builds its own `prometheus.NewRegistry()` for two reasons, and this pins the
 * second: a test can hold an isolated registry only if nothing leaked into the global one.
 */
assert('nothing reached prom-client\'s GLOBAL register', () =>
    globalRegister.getSingleMetric('jovimall_http_requests_total') === undefined
    && globalRegister.getSingleMetric('jovimall_worker_runs_total') === undefined);

// ═══ 7. The scrubber ══════════════════════════════════════════════════════════

section('Scrubber — a net over free text, and it must not lie in either direction');

/**
 * Two properties, and the second is the one that keeps the feature alive.
 *
 * A scrubber that mangles ordinary output is one every author works around, so the
 * false-positive assertions below matter as much as the redaction ones. Both directions are
 * driven from literals — the point is to pin the regexes, not to re-derive them.
 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

assert('a JWT is redacted — the exact defect wi-admin\'s logger header records', () =>
    scrubText(`auth ${JWT}`) === 'auth [REDACTED:jwt]');

assert('a Bearer credential is redacted but its SCHEME survives', () =>
    scrubText('Authorization: Bearer abcdef1234567890xyz') === 'Authorization: Bearer [REDACTED]');

assert('a Stripe key keeps its live/test prefix — ADR-014 D-2 calls that the useful fact', () => {
    const live = scrubText('key sk_live_51H8xQ2LkdIwHu7ix');
    const test = scrubText('key sk_test_51H8xQ2LkdIwHu7ix');
    return live.startsWith('key sk_live_') && !live.includes('51H8xQ2')
        && test.startsWith('key sk_test_') && !test.includes('51H8xQ2');
});

assert('a Mongo URI loses BOTH userinfo halves, not just the password', () =>
    scrubText('mongodb://admin:s3cr3t@localhost:27017/jovi_mall')
        === 'mongodb://[REDACTED]@localhost:27017/jovi_mall');

assert('a Redis URL loses its userinfo', () =>
    !scrubText('redis://default:hunter2@127.0.0.1:6379').includes('hunter2'));

assert('a JSON credential field is redacted', () =>
    scrubText('{"token": "abc123def456"}') === '{"token": "[REDACTED]"}');

assert('a query-string credential is redacted and the rest of the string survives', () =>
    scrubText('password=hunter2&next=1') === 'password=[REDACTED]&next=1');

assert('a PEM private key block is redacted whole', () =>
    scrubText('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----')
        === '[REDACTED:private-key]');

/**
 * Idempotence is not a nicety.
 *
 * A line can pass the hook and be re-rendered, and the first implementation of the field rule
 * grew one `]` per pass — `[REDACTED]]]`. Caught here rather than in production.
 */
assert('scrubbing twice equals scrubbing once, for every shape', () => {
    const inputs = [
        `auth ${JWT}`,
        'Authorization: Bearer abcdef1234567890xyz',
        'key sk_live_51H8xQ2LkdIwHu7ix',
        'mongodb://admin:s3cr3t@localhost:27017/jovi_mall',
        '{"token": "abc123def456"}',
        'password=hunter2&next=1',
    ];
    return inputs.every((input) => {
        const once = scrubText(input);
        return scrubText(once) === once;
    });
});

/** The over-eager-regex regression guard. Each of these is a real, common log line here. */
assert('an ObjectId is NOT redacted — 24-hex appears in most shipment lines', () => {
    const line = 'Shipment 507f1f77bcf86cd799439011 moved to in_transit';
    return scrubText(line) === line;
});

assert('a sha-256 upload fingerprint is NOT redacted', () => {
    const line = 'upload sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    return scrubText(line) === line;
});

assert('the WORD "token" without a value is untouched', () =>
    scrubText('token refreshed for agent') === 'token refreshed for agent');

assert('a near-miss key like tokenId is untouched', () =>
    scrubText('tokenId: 5 and accountId: 9') === 'tokenId: 5 and accountId: 9');

assert('a credential-free URI is untouched', () =>
    scrubText('Connected to mongodb://localhost:27017/jovi_mall')
        === 'Connected to mongodb://localhost:27017/jovi_mall');

assert('ordinary operational output is byte-identical', () =>
    scrubText('[Scheduler] Found 12 active vendors') === '[Scheduler] Found 12 active vendors');

assert('the scrubbed field names derive from the audit sanitiser, minus its path fragments', () =>
    SCRUBBED_FIELD_NAMES.includes('password')
    && SCRUBBED_FIELD_NAMES.includes('refreshtoken')
    && SCRUBBED_FIELD_NAMES.every((name) => /^[a-z0-9_]+$/.test(name)));

/**
 * The trap that would take the process down at boot.
 *
 * `SENSITIVE_FIELD_NAMES` deliberately carries two bracketed PATH FRAGMENTS so the
 * cross-service name comparison lines up. pino throws on an invalid redact path, so an
 * unfiltered spread would fail at logger construction — in production, at boot.
 */
assert('no redact path carries a stray bracket fragment', () =>
    REDACTED_PATHS.every((path) => !path.includes('headers["x-service-token"') || path.startsWith('req.')));

assert('the redact paths cover both a top-level and a nested credential field', () =>
    REDACTED_PATHS.includes('password') && REDACTED_PATHS.includes('*.password'));

assert('a message is truncated BEFORE it can be scrubbed, and says so', () => {
    const long = 'x'.repeat(5000);
    const out = truncateMessage(long, 100);
    return out.length < 200 && out.includes('truncated') && out.includes('5000');
});

// ═══ 8. Ring buffer ═══════════════════════════════════════════════════════════

section('Ring buffer — two bounds, and it admits what it dropped');

function makeRecord(over: Partial<LogRecord> = {}): LogRecord {
    return {
        at: new Date().toISOString(),
        level: 'info',
        msg: 'hello',
        source: 'logger',
        requestId: null,
        actorId: null,
        ...over,
    };
}

assert('it evicts on the COUNT bound and keeps the newest', () => {
    const ring = new LogRingBuffer(3, 10 * 1024 * 1024);
    for (let i = 0; i < 5; i += 1) ring.push(makeRecord({ msg: `m${i}` }));
    const found = ring.query({ limit: 10 });
    return found.length === 3 && found[0].msg === 'm4' && found[2].msg === 'm2';
});

/**
 * The bound that actually holds. 2000 entries of a 100 KB stack is 200 MB of retained heap
 * inside a process that is, by hypothesis, already having a bad day.
 */
assert('it evicts on the BYTE bound long before the count bound', () => {
    const ring = new LogRingBuffer(1000, 2000);
    for (let i = 0; i < 20; i += 1) ring.push(makeRecord({ msg: 'y'.repeat(300) }));
    return ring.stats().stored < 20 && ring.stats().bytes <= 2000;
});

assert('droppedSinceBoot counts what fell out — otherwise "full" reads as "quiet"', () => {
    const ring = new LogRingBuffer(2, 10 * 1024 * 1024);
    for (let i = 0; i < 6; i += 1) ring.push(makeRecord({ msg: `m${i}` }));
    return ring.stats().droppedSinceBoot === 4 && ring.stats().stored === 2;
});

assert('it reads newest-first', () => {
    const ring = new LogRingBuffer(10, 10 * 1024 * 1024);
    ring.push(makeRecord({ msg: 'first' }));
    ring.push(makeRecord({ msg: 'second' }));
    return ring.query({ limit: 10 })[0].msg === 'second';
});

assert('level filtering is at-or-above, never equal-to', () => {
    const ring = new LogRingBuffer(10, 10 * 1024 * 1024);
    ring.push(makeRecord({ level: 'info', msg: 'i' }));
    ring.push(makeRecord({ level: 'error', msg: 'e' }));
    ring.push(makeRecord({ level: 'warn', msg: 'w' }));
    const found = ring.query({ level: 'warn', limit: 10 }).map((r) => r.msg);
    return found.length === 2 && found.includes('e') && found.includes('w');
});

assert('requestId filtering is exact — this is the cross-service join', () => {
    const ring = new LogRingBuffer(10, 10 * 1024 * 1024);
    ring.push(makeRecord({ requestId: 'req-1', msg: 'a' }));
    ring.push(makeRecord({ requestId: 'req-2', msg: 'b' }));
    const found = ring.query({ requestId: 'req-1', limit: 10 });
    return found.length === 1 && found[0].msg === 'a';
});

assert('the text filter is a literal substring, never a caller-supplied regex', () => {
    const ring = new LogRingBuffer(10, 10 * 1024 * 1024);
    ring.push(makeRecord({ msg: 'payment failed' }));
    ring.push(makeRecord({ msg: 'shipment delivered' }));
    // `.*` must find nothing: if it matched everything, `q` would be a regex and a ReDoS.
    return ring.query({ q: '.*', limit: 10 }).length === 0
        && ring.query({ q: 'PAYMENT', limit: 10 }).length === 1;
});

assert('the limit is honoured', () => {
    const ring = new LogRingBuffer(50, 10 * 1024 * 1024);
    for (let i = 0; i < 20; i += 1) ring.push(makeRecord());
    return ring.query({ limit: 5 }).length === 5;
});

assert('the scope note says PROCESS-LOCAL, as describeWorkers() does for its booleans', () =>
    new LogRingBuffer(2, 1000).stats().scopeNote.includes('PROCESS-LOCAL'));

assert('an unparseable line is counted, not thrown', () => {
    const ring = new LogRingBuffer(2, 1000);
    ring.noteUnparseable();
    return ring.stats().unparseableSinceBoot === 1;
});

// ═══ 9. Console bridge ════════════════════════════════════════════════════════

section('Console bridge — the largest risk in the phase, so it is pinned hard');

/**
 * Env is set and the memoised config/logger dropped, so this section drives the real modules
 * rather than a parallel construction. `LOG_STDOUT=false` keeps pino's output from interleaving
 * with the assertion output and making a failure unreadable.
 */
process.env.LOG_STDOUT = 'false';
process.env.LOG_CONSOLE_BRIDGE = 'true';
process.env.LOG_LEVEL = 'debug';
process.env.LOG_PERSIST_ENABLED = 'false';
__resetLoggingConfigForTests();
__resetLoggerForTests();

const nativeTable = console.table;
const nativeDir = console.dir;
const nativeTrace = console.trace;

initLogging();

assert('the bridge installed', () => isConsoleBridgeInstalled());

assert('exactly the five level-shaped methods are bridged', () =>
    BRIDGED_METHODS.length === 5
    && ['log', 'info', 'warn', 'error', 'debug'].every((m) => BRIDGED_METHODS.includes(m as never)));

/**
 * `console.table`/`dir`/`trace` are formatting tools, not levels — a line-oriented logger
 * renders them worse than the console does. Asserted so nobody "completes" the set later.
 */
assert('console.table, dir and trace stay NATIVE', () =>
    console.table === nativeTable && console.dir === nativeDir && console.trace === nativeTrace);

assert('a bridged console.log reaches the ring, tagged as console-sourced', () => {
    console.log('bridged-line-alpha');
    const found = logRing().query({ q: 'bridged-line-alpha', limit: 5 });
    return found.length === 1 && found[0].source === 'console' && found[0].level === 'info';
});

assert('console.warn and console.error map to their own levels', () => {
    console.warn('bridged-warn-beta');
    console.error('bridged-error-gamma');
    return logRing().query({ q: 'bridged-warn-beta', limit: 5 })[0]?.level === 'warn'
        && logRing().query({ q: 'bridged-error-gamma', limit: 5 })[0]?.level === 'error';
});

/**
 * The single biggest free win in the phase: 311 existing `console.error('…', err)` sites become
 * structured errors with a searchable stack, without one of them being edited.
 */
assert('an Error argument becomes a structured err binding, not text', () => {
    console.error('exploded:', new Error('kaboom-delta'));
    const found = logRing().query({ q: 'exploded', limit: 5 })[0];
    return found?.err?.message === 'kaboom-delta'
        && found.err.type === 'Error'
        && (found.err.stack ?? '').includes('kaboom-delta')
        && !found.msg.includes('kaboom-delta');
});

assert('the scrubber runs on bridged output too — the hook covers both paths', () => {
    console.log(`leaked ${JWT}`);
    const found = logRing().query({ q: 'leaked', limit: 5 })[0];
    return found !== undefined && !found.msg.includes('eyJhbGciOi') && found.msg.includes('[REDACTED:jwt]');
});

assert('format placeholders still render, as console.* itself would', () => {
    console.log('%s has %d items', 'cart-epsilon', 3);
    return logRing().query({ q: 'cart-epsilon has 3 items', limit: 5 }).length === 1;
});

assert('installing twice is a no-op rather than a double-wrap', () => {
    const before = console.log;
    installConsoleBridge();
    return console.log === before;
});

/** A sink that logs must terminate at depth one, not blow the stack mid-incident. */
assert('a nested sink invocation is dropped and counted', () => {
    const before = suppressedSinkCalls();
    runInSink(() => {
        runInSink(() => {
            throw new Error('this inner body must never run');
        });
    });
    return suppressedSinkCalls() === before + 1;
});

assert('the ALS request context stamps requestId onto every line inside it', () => {
    runWithRequestContext({ requestId: 'req-zeta', method: 'GET', path: '/x' }, () => {
        console.log('inside-context-zeta');
    });
    return logRing().query({ q: 'inside-context-zeta', limit: 5 })[0]?.requestId === 'req-zeta';
});

assert('a line outside any request carries no requestId — a worker is not a request', () => {
    console.log('outside-context-eta');
    return logRing().query({ q: 'outside-context-eta', limit: 5 })[0]?.requestId === null;
});

/** The kill switch has to actually restore, or it is not one. */
assert('uninstalling restores the captured native methods', () => {
    uninstallConsoleBridge();
    const restored = console.log === originalConsole.log && console.error === originalConsole.error;
    installConsoleBridge();
    return restored;
});

assert('the Mongo sink is inert while persistence is disabled', () =>
    logMongoSink.describe().enabled === false && logMongoSink.state() === 'disabled');

uninstallConsoleBridge();

// ═══ 10. Exposed config ═══════════════════════════════════════════════════════

section('Exposed config — a whitelist, checked against the real credential names');

assert('the shipped whitelist passes its own boot assertion', () => {
    assertExposedConfigSafe();
    return true;
});

/**
 * The assertion that stays useful as the whitelist grows.
 *
 * "The current list passes" is trivially true the moment it is written. Driving the regex
 * against this service's REAL credential variables — every one of them read from `process.env`
 * somewhere in `src/` — is what proves the rule still covers the shapes this codebase actually
 * uses.
 */
const REAL_CREDENTIAL_NAMES = [
    'JWT_SECRET', 'JWT_REFRESH_SECRET', 'INTERNAL_SERVICE_TOKEN', 'INTERNAL_ADMIN_SERVICE_TOKEN',
    'METRICS_SCRAPE_TOKEN', 'GEO_TRACKER_WEBHOOK_SECRET', 'OAUTH_STATE_SECRET', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_TOKEN_ENCRYPTION_KEY', 'FCM_PRIVATE_KEY', 'STORAGE_FIREBASE_PRIVATE_KEY',
    'STORAGE_CLOUDINARY_API_SECRET', 'STORAGE_CLOUDINARY_API_KEY', 'VECTORISER_API_KEY',
    'GEO_GOOGLE_API_KEY', 'GEO_MAPBOX_TOKEN', 'TELEGRAM_BOT_TOKEN', 'WHATSAPP_ACCESS_TOKEN',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NOTCHPAY_API_KEY', 'NOTCHPAY_WEBHOOK_SECRET',
    'MYCOOLPAY_API_KEY', 'MYCOOLPAY_WEBHOOK_SECRET', 'SMTP_PASS', 'MONGO_URI', 'MONGODB_URI',
    'REDIS_URL', 'WHATSAPP_API_URL', 'VECTORISER_BASE_URL',
];

assert(`the token rule rejects all ${REAL_CREDENTIAL_NAMES.length} real credential variables`, () => {
    const missed = REAL_CREDENTIAL_NAMES.filter((name) => !FORBIDDEN_CONFIG_TOKEN.test(name));
    if (missed.length > 0) console.error(`      missed: ${missed.join(', ')}`);
    return missed.length === 0;
});

assert('no whitelisted key is itself credential-shaped', () =>
    EXPOSED_CONFIG_KEYS.every((key) => !FORBIDDEN_CONFIG_TOKEN.test(key)));

/**
 * `SMTP_USER` matches no forbidden token and no sensitive leaf name, yet is half a credential.
 * Its absence is a human decision, and this pins it — the honest demonstration that the
 * whitelist is the control and the regex is only the backstop.
 */
assert('SMTP_USER is absent, and the regex genuinely cannot catch it', () =>
    !FORBIDDEN_CONFIG_TOKEN.test('SMTP_USER')
    && !(EXPOSED_CONFIG_KEYS as readonly string[]).includes('SMTP_USER'));

assert('no connection string or base URL is exposed', () =>
    !(EXPOSED_CONFIG_KEYS as readonly string[]).some((key) =>
        ['MONGO_URI', 'MONGODB_URI', 'REDIS_URL', 'GEO_TRACKER_BASE_URL', 'STOREFRONT_URL'].includes(key)));

assert('the TIMEOUT/TOKEN near-miss is not a false positive', () =>
    !FORBIDDEN_CONFIG_TOKEN.test('SHIPMENT_OFFER_TIMEOUT_SECONDS')
    && !FORBIDDEN_CONFIG_TOKEN.test('GEO_TRACKER_REQUEST_TIMEOUT_MS'));

assert('every entry renders as a scalar or null, never an object', () =>
    exposedConfig().every((entry) =>
        entry.value === null || ['string', 'number', 'boolean'].includes(typeof entry.value)));

assert('an unset key reports set:false rather than pretending to have no default', () => {
    delete process.env.ANALYTICS_AGGREGATION_CRON;
    const entry = exposedConfig().find((e) => e.key === 'ANALYTICS_AGGREGATION_CRON');
    return entry !== undefined && entry.set === false && entry.value === null;
});

assert('the boot assertion FIRES on a credential-shaped key — it is not vacuous', () => {
    // Proves the mechanism, without mutating the frozen shipped list.
    const wouldReject = ['STRIPE_SECRET_KEY', 'MONGO_URI', 'SOME_PASSWORD', 'A_DSN_B']
        .every((key) => FORBIDDEN_CONFIG_TOKEN.test(key));
    return wouldReject;
});

assert('the wiring block reports derived predicates and never a URL', () => {
    const wiring = configWiring();
    return 'geoTrackerConfigured' in wiring
        && 'stripeKeyMode' in wiring
        && Object.values(wiring).every((value) => typeof value !== 'string' || !value.includes('://'));
});

// ═══ 11. Cache inspection ═════════════════════════════════════════════════════

section('Cache inspection — shares the flush\'s escaping, drops two of its guards');

assert('an unknown database is refused, by name', () => {
    const plan = resolveInspectPlan({ db: 'NOT_A_DB' }, 500);
    return !plan.ok && plan.code === 'unknown_db';
});

assert('glob metacharacters in the prefix are escaped, and WE append the star', () => {
    const plan = resolveInspectPlan({ db: 'SLOT_LOCK_DB', prefix: 'slot:[a-z]*' }, 500);
    return plan.ok && plan.match === 'slot:\\[a-z\\]\\**';
});

assert('prefix "*" is refused rather than escaped into a literal that matches nothing', () => {
    const plan = resolveInspectPlan({ db: 'SLOT_LOCK_DB', prefix: '*' }, 500);
    return !plan.ok && plan.code === 'invalid_prefix';
});

/**
 * The two deliberate asymmetries with the flush. Pinned so they read as decisions.
 */
assert('inspection does NOT require confirm — typing a name to LOOK trains reflexive confirming', () => {
    const plan = resolveInspectPlan({ db: 'DOWNLOAD_TOKEN_DB' }, 500);
    return plan.ok;
});

assert('inspection PERMITS a whole-DB listing on a destructive database — looking is not clearing', () => {
    const inspect = resolveInspectPlan({ db: 'DOWNLOAD_TOKEN_DB' }, 500);
    const flush = resolveFlushPlan({ db: 'DOWNLOAD_TOKEN_DB', confirm: 'DOWNLOAD_TOKEN_DB' }, 500);
    return inspect.ok && !flush.ok && flush.code === 'whole_db_not_allowed';
});

assert('the limit is clamped to the ceiling', () => {
    const plan = resolveInspectPlan({ db: 'SLOT_LOCK_DB', limit: 99_999 }, 500);
    return plan.ok && plan.limit === 500;
});

assert('the blast radius travels with the plan even though nothing is deleted', () => {
    const plan = resolveInspectPlan({ db: 'WA_IDEMPOTENCY_DB' }, 500);
    return plan.ok && plan.destructive && plan.blastRadius.length > 20;
});

assert('the Redis allowlist contains no write command', () => {
    const writes = ['set', 'del', 'unlink', 'flushdb', 'flushall', 'expire', 'select', 'sendCommand'];
    return REDIS_READ_COMMANDS.every((cmd) => !writes.includes(cmd))
        && !isRedisReadCommand('del')
        && !isRedisReadCommand('sendCommand');
});

// ═══ 12. Index drift ══════════════════════════════════════════════════════════

section('Index drift — driven from literals, so the normaliser itself is pinned');

// `number | string`, not `number`: a direction may be `'text'` or `'2dsphere'`, and the
// narrower signature this used to carry made the whole `$text` case inexpressible here —
// which is part of why a permanent false positive on `products` went unnoticed.
const idx = (key: Record<string, number | string>, options: Record<string, unknown> = {}) =>
    normaliseIndex(key, options);

assert('a declared index absent from the database is `missing` — the actionable bucket', () => {
    const drift = diffIndexes([idx({ email: 1 })], []);
    return drift.missing.length === 1 && drift.extra.length === 0;
});

assert('a live index nobody declares is `extra`', () => {
    const drift = diffIndexes([], [idx({ legacy_field: 1 })]);
    return drift.extra.length === 1 && drift.missing.length === 0;
});

assert('a unique mismatch is reported — a "unique" index that is not unique in production', () => {
    const drift = diffIndexes([idx({ sku: 1 }, { unique: true })], [idx({ sku: 1 })]);
    return drift.mismatched.length === 1
        && drift.mismatched[0].declared.unique
        && !drift.mismatched[0].live.unique;
});

/**
 * A partial-filter difference reports as MISSING + EXTRA, not as `mismatched`.
 *
 * ⚠ This assertion used to expect `mismatched.length === 1`, and it changed when the partial
 * filter became part of `indexIdentity` (see that function, and the subscriber_plans pair
 * asserted below). The new bucket is not merely a different colour on the same finding — it
 * is better advice:
 *
 *   `mismatched` means "one index, wrong options", whose only remedy is DROP and recreate.
 *   But a partial index and a full index on the same key COEXIST perfectly well in MongoDB —
 *   that is the entire reason it permits several indexes on one key and demands distinct
 *   names for them. So the declared partial index here can simply be CREATED, and the
 *   undeclared full one is ordinary residue. Reporting it as `mismatched` told an operator to
 *   drop something they did not need to drop.
 *
 * The line the two buckets now fall on is a principled one, and worth keeping in mind before
 * widening either: IDENTITY is what MongoDB uses to decide whether two indexes may coexist;
 * OPTIONS are what must agree on the single index that does exist. `unique` and
 * `expireAfterSeconds` stay options — MongoDB refuses a second index on one key differing
 * only in those — which is why the two assertions either side of this one are unchanged.
 *
 * (Collation belongs on the identity side by that rule and is deliberately not there:
 * `NormalisedIndex` does not carry it, MongoDB reports a default collation on every index,
 * and no two indexes in this codebase share a key while differing only by it. This file's
 * header argues the narrow case; widen it when a real drift is proven to hide behind it.)
 */
assert('a partialFilterExpression difference is missing + extra, not a mismatch', () => {
    const drift = diffIndexes(
        [idx({ a: 1 }, { partialFilterExpression: { deletedAt: null } })],
        [idx({ a: 1 })],
    );
    return drift.missing.length === 1
        && drift.missing[0].partialFilterExpression === JSON.stringify({ deletedAt: null })
        && drift.extra.length === 1
        && drift.mismatched.length === 0;
});

assert('a TTL mismatch is reported', () => {
    const drift = diffIndexes(
        [idx({ createdAt: 1 }, { expireAfterSeconds: 3600 })],
        [idx({ createdAt: 1 }, { expireAfterSeconds: 60 })],
    );
    return drift.mismatched.length === 1;
});

/**
 * Compound key ORDER is part of an index's identity — `{a,b}` and `{b,a}` have different prefix
 * behaviour. Sorting the key before comparing would report "no drift" for a genuinely missing
 * index, which is the worst possible failure for this endpoint.
 */
assert('key ORDER is significant — {a,b} is not {b,a}', () => {
    const drift = diffIndexes([idx({ a: 1, b: 1 })], [idx({ b: 1, a: 1 })]);
    return drift.missing.length === 1 && drift.extra.length === 1 && drift.mismatched.length === 0;
});

assert('_id_ is never reported — it would be one false positive per collection', () => {
    const drift = diffIndexes([], [idx({ _id: 1 }, { name: '_id_' })]);
    return drift.extra.length === 0;
});

/**
 * A `$text` index is declared in one shape and REPORTED in another, and comparing them
 * verbatim produced a permanent false `missing` + false `extra` on `products` — the one
 * collection in this codebase carrying one, and one `verify:storefront` proves exists.
 *
 * It went unnoticed while the diff was a page somebody opened. Plan step 2.C.4 put it on
 * the boot path at `warn`, so it became a warning printed on every start telling operators
 * to run a migration that would not fix it. The fixture below is the exact shape
 * `listIndexes()` returns for `product_storefront_text`, taken off the dev database.
 */
assert('a $text index is not permanent drift — the live sentinel expands from weights', () => {
    const drift = diffIndexes(
        [idx({ title: 'text', tags: 'text', description: 'text' },
            { name: 'product_storefront_text', weights: { title: 10, tags: 4, description: 1 } })],
        [idx({ _fts: 'text', _ftsx: 1 },
            { name: 'product_storefront_text', weights: { description: 1, tags: 4, title: 10 }, textIndexVersion: 3 })],
    );
    return drift.missing.length === 0 && drift.extra.length === 0 && drift.mismatched.length === 0;
});

// Sorting is safe HERE and nowhere else: a text index has no prefix semantics, so field
// order carries no meaning — unlike the compound case asserted above, where it is the identity.
assert('…and declaration ORDER of text fields does not matter', () => {
    const drift = diffIndexes(
        [idx({ description: 'text', title: 'text' }, { weights: { description: 1, title: 10 } })],
        [idx({ _fts: 'text', _ftsx: 1 }, { weights: { title: 10, description: 1 } })],
    );
    return drift.missing.length === 0 && drift.extra.length === 0;
});

// A text index that genuinely covers different fields must still report. Widening the
// canonicalisation until nothing text-shaped ever drifts would trade one false positive
// for a false negative on the only $text index this service has.
assert('a $text index over DIFFERENT fields still reports as drift', () => {
    const drift = diffIndexes(
        [idx({ title: 'text', tags: 'text' }, { weights: { title: 10, tags: 4 } })],
        [idx({ _fts: 'text', _ftsx: 1 }, { weights: { title: 10 } })],
    );
    return drift.missing.length === 1 && drift.extra.length === 1;
});

// Belt and braces: a live text index whose `weights` the driver did not return cannot be
// expanded, and must be left alone rather than guessed at.
assert('a live text sentinel with no weights is passed through untouched', () =>
    JSON.stringify(normaliseIndex({ _fts: 'text', _ftsx: 1 }, {}).key) === '{"_fts":"text","_ftsx":1}');

/**
 * TWO PARTIAL INDEXES ON ONE KEY ARE TWO INDEXES, and the diff used to see one.
 *
 * MongoDB allows several indexes on the same key when their `partialFilterExpression`s
 * differ, and requires distinct names when they do. `subscriber_plans` is the case in this
 * codebase — `uniq_active_per_owner` and `uniq_pending_per_owner`, together the "at most one
 * active and one pending plan per owner" invariant, and the schema says as much where they
 * are declared.
 *
 * While `indexIdentity` was the key alone, both collapsed into one map entry: the live
 * pending index satisfied the lookup for the declared active one, and a missing
 * `uniq_active_per_owner` reported as NO DRIFT. Found while rehearsing
 * `migrate:declared-indexes`, which plans from this verdict and would have built one of the
 * two, skipped the other and exited 0 — the half-creating-and-reporting-success failure, one
 * layer below where it was being guarded against.
 */
assert('two partial indexes on ONE key are two indexes, not one', () => {
    const active = idx({ owner_type: 1, owner_id: 1 },
        { unique: true, name: 'uniq_active_per_owner', partialFilterExpression: { status: 'active' } });
    const pending = idx({ owner_type: 1, owner_id: 1 },
        { unique: true, name: 'uniq_pending_per_owner', partialFilterExpression: { status: 'pending_activation' } });

    // Only the pending one exists: the active one is missing, and must say so.
    const drift = diffIndexes([active, pending], [pending]);
    return drift.missing.length === 1
        && drift.missing[0].partialFilterExpression === JSON.stringify({ status: 'active' })
        && drift.extra.length === 0
        && drift.mismatched.length === 0;
});

// The other direction: an index with NO partial filter keeps a byte-identical identity, so
// nothing that worked before this changed behaviour — `_id_` above is filtered by that exact
// string, and a plain unique-vs-non-unique pair must still read as `mismatched`, not as a
// missing/extra pair.
assert('…and an index without a partial filter is unaffected', () => {
    const drift = diffIndexes([idx({ sku: 1 }, { unique: true })], [idx({ sku: 1 })]);
    return drift.mismatched.length === 1 && drift.missing.length === 0 && drift.extra.length === 0;
});

assert('a name-only difference is NOT drift — MongoDB generates names', () => {
    const drift = diffIndexes(
        [idx({ status: 1 }, { name: 'status_idx' })],
        [idx({ status: 1 }, { name: 'status_1' })],
    );
    return drift.missing.length === 0 && drift.extra.length === 0 && drift.mismatched.length === 0;
});

assert('harmless server-added fields are not drift', () => {
    const drift = diffIndexes(
        [idx({ geo: 1 })],
        [idx({ geo: 1 }, { v: 2, background: true, '2dsphereIndexVersion': 3 })],
    );
    return drift.mismatched.length === 0;
});

// ═══ 13. Safe execution boundaries ════════════════════════════════════════════

section('Safe execution boundaries — the brief\'s last line, enforced');

/**
 * Comments are stripped BEFORE scanning, and that is not a detail.
 *
 * `FLUSHALL` and `KEYS ` appear in this codebase today only inside the doc comments that
 * document the ban on them (`cache-flush-policy.ts`, `cache-flush.service.ts`,
 * `admin-dev-tools.routes.ts`). A naive scan would fail on precisely the files that get it right.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*');
        })
        .join('\n');
}

function readSources(dir: string): Array<{ file: string; code: string }> {
    const out: Array<{ file: string; code: string }> = [];
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) {
                out.push({ file: full, code: stripComments(readFileSync(full, 'utf8')) });
            }
        }
    };
    walk(dir);
    return out;
}

const SRC = join(__dirname, '..', '..', 'src');
const OPS_SOURCES = [
    ...readSources(join(SRC, 'modules', 'system')),
    ...readSources(join(SRC, 'modules', 'dev-tools')),
    ...readSources(join(SRC, 'core', 'logging')),
];

const BANNED = [
    'child_process', 'execSync', 'execFile', 'spawn(', 'fork(',
    'eval(', 'new Function(', "require('vm')", 'require("vm")',
    '$where', '$function', '$accumulator', 'mapReduce',
    'sendCommand(', 'FLUSHALL', 'FLUSHDB',
];

for (const token of BANNED) {
    assert(`no operations source contains \`${token}\``, () => {
        const hits = OPS_SOURCES.filter((s) => s.code.includes(token)).map((s) => s.file);
        if (hits.length > 0) console.error(`      ${hits.join('\n      ')}`);
        return hits.length === 0;
    });
}

/**
 * Redis's `KEYS`, banned PRECISELY rather than by substring.
 *
 * The obvious token — `'KEYS '` — is a false positive generator, and it fired on the first run
 * against `EXPOSED_CONFIG_KEYS =`, `WORKER_KEYS`, `FLUSHABLE_DBS` and friends. A ban that cries
 * wolf on ordinary identifiers gets deleted by the next person to hit it, taking the real
 * protection with it. So the rule names the two shapes the command can actually take: a quoted
 * command literal, and a `.keys(` call on a client (`Object.keys` and `Map.keys` are excluded,
 * being neither).
 *
 * The load-bearing control is still `REDIS_READ_COMMANDS`, asserted above — `keys` is not on it,
 * so the command cannot be issued through `runReadCommand` at all.
 */
assert('no operations source issues Redis KEYS (O(n), blocks the event loop)', () => {
    const offenders: string[] = [];
    for (const { file, code } of OPS_SOURCES) {
        if (/['"]KEYS['"]/.test(code)) offenders.push(`${file} (quoted command)`);
        if (/(?<!Object|Map|Reflect|params|headers|searchParams)\.keys\s*\(/.test(code)) {
            offenders.push(`${file} (.keys() call)`);
        }
    }
    if (offenders.length > 0) console.error(`      ${offenders.join('\n      ')}`);
    return offenders.length === 0;
});

/**
 * `.command(` cannot simply be banned — `probeMongoServerDetail` legitimately issues
 * `db.admin().command({ serverStatus: 1 })`. The rule that bans a passthrough while permitting
 * a named call is that the argument must be an OBJECT LITERAL, never a variable.
 */
assert('every .command(/.runCommand( is followed immediately by an object literal', () => {
    const offenders: string[] = [];
    for (const { file, code } of OPS_SOURCES) {
        const calls = (code.match(/\.(command|runCommand)\(/g) ?? []).length;
        const literals = (code.match(/\.(command|runCommand)\(\s*\{/g) ?? []).length;
        if (calls !== literals) offenders.push(`${file} (${calls} calls, ${literals} literal)`);
    }
    if (offenders.length > 0) console.error(`      ${offenders.join('\n      ')}`);
    return offenders.length === 0;
});

assert('the cache key inspector issues no direct client call outside the allowlist helper', () => {
    const source = OPS_SOURCES.find((s) => s.file.endsWith('cache-keys.service.ts'));
    if (!source) return false;
    // `client.` appears only in the null check; every command goes through `runReadCommand`.
    const directCalls = source.code.match(/client\.[a-zA-Z]+\(/g) ?? [];
    return directCalls.length === 0;
});

assert('the system router declares no mutating route — the split is a MOUNT, not a convention', () => {
    const source = readFileSync(join(SRC, 'modules', 'system', 'admin-system.routes.ts'), 'utf8');
    return !/router\.(post|put|patch|delete)\s*\(/.test(stripComments(source));
});

assert('the database inspector names collections only from the frozen registry', () => {
    const parsed = DatabaseInspectQuerySchema.safeParse({ collection: 'users' });
    const rejected = DatabaseInspectQuerySchema.safeParse({ collection: 'system.indexes' });
    return parsed.success && !rejected.success;
});

assert('the log search rejects an over-long term rather than passing it to a regex', () => {
    return !LogQuerySchema.safeParse({ q: 'x'.repeat(101) }).success
        && LogQuerySchema.safeParse({ q: 'payment failed' }).success;
});

// ═══ 14. Outbox prune policy ══════════════════════════════════════════════════

section('Outbox prune — the phase\'s one new dangerous verb');

const prune = (over: Partial<Parameters<typeof resolvePrunePlan>[0]> = {}) =>
    resolvePrunePlan(
        { olderThanDays: 30, status: 'sent', confirm: '30', ...over },
        new Date('2026-08-12T00:00:00.000Z'),
    );

assert('a well-formed request is accepted', () => prune().ok);

/**
 * `status` is a literal, not an enum, and these two assertions are the reason.
 * Pruning `failed` destroys the input to `outbox/replay`; pruning `pending` destroys
 * undelivered events outright.
 */
assert('status "failed" is REFUSED — that is the input to outbox/replay', () => {
    const plan = prune({ status: 'failed' });
    return !plan.ok && plan.code === 'status_not_prunable';
});

assert('status "pending" is REFUSED — those events never reached geo-tracker', () => {
    const plan = prune({ status: 'pending' });
    return !plan.ok && plan.code === 'status_not_prunable';
});

assert('the 7-day floor is hard', () => {
    const plan = prune({ olderThanDays: 1, confirm: '1' });
    return !plan.ok && plan.code === 'age_below_floor';
});

assert('the 365-day ceiling holds', () => {
    const plan = prune({ olderThanDays: 400, confirm: '400' });
    return !plan.ok && plan.code === 'age_above_ceiling';
});

assert('confirm must repeat the AGE, not a magic word', () => {
    const wrong = prune({ confirm: 'sent' });
    const right = prune({ confirm: '30' });
    return !wrong.ok && wrong.code === 'confirmation_mismatch' && right.ok;
});

assert('dryRun defaults TRUE, mirroring the cache flush', () => {
    const plan = prune();
    return plan.ok && plan.dryRun === true;
});

assert('dryRun:false is honoured — an operator can actually delete', () => {
    const plan = prune({ dryRun: false });
    return plan.ok && plan.dryRun === false;
});

assert('the cutoff is computed from the supplied clock, not Date.now()', () => {
    const plan = prune({ olderThanDays: 10, confirm: '10' });
    return plan.ok && plan.cutoff.toISOString() === '2026-08-02T00:00:00.000Z';
});

assert('the limit is clamped to the ceiling', () => {
    const plan = prune({ limit: 999_999 });
    return plan.ok && plan.limit === 50_000;
});

// ═══ Worker inventory, after the 13th landed ══════════════════════════════════

section('Worker inventory — the thirteenth worker was invisible to every surface');

// 16 since Phase 6 Step 3 added AgentTrustRecomputeWorker — the nightly composite trust
// recompute. It is the one worker here that writes nothing an agent can feel: it fills the
// SHADOW `trust_signals.composite_score` and never `cod.trust_score`, so a pass moves no
// COD cash limit (Phase 6 D-2; `test:agent-trust` pins that by source scan).
// 15 since plan step 3.A.3 added TrackingAllowReconcileWorker — the only thing that
// re-delivers a tracking REVOCATION whose outbox row the dispatcher parked as `failed`,
// and the one cross-service event with no other recovery path (geo-tracker's
// `agentHasActiveShipment` aggregate covers the shipment events; nothing covers this one).
// 14 before that, since Phase 1 added PaymentReconciliationWorker — the sweep that closes
// a mobile-money payment whose callback never arrived.
//
// The count is hardcoded on purpose: a worker added without an inventory entry is invisible
// to every operations surface AND is never stopped by the drain, which is the defect this
// section was written about. Do not weaken it to `>=`.
// 18 -> 19: PlanQuotaReconcileWorker, the drift sweep that repairs plan-quota enforcement
// when the `plan.activated` event that should have done it was lost — and that releases an
// owner's held-back products once they free room, which no plan change announces.
assert('the inventory now holds 19 workers', () => WORKER_INVENTORY.length === 19);

/**
 * The new one, asserted by name and by the two properties that make it a backstop rather
 * than a second delivery timer: its schedule is derived from the env var it actually uses,
 * and it is INERT when geo-tracker is not configured — the same posture as the dispatcher it
 * feeds, so a local deploy does not accumulate re-pushes nothing will ever drain.
 */
assert('tracking-allow-reconcile is registered AND triggerable', () =>
    WORKER_KEYS.includes('tracking-allow-reconcile' as never)
    && WORKER_INVENTORY.some((e) => e.key === 'tracking-allow-reconcile' && e.triggerable));

assert('its interval is derived from TRACKING_ALLOW_RECONCILE_INTERVAL_MS, not a literal', () => {
    const entry = WORKER_INVENTORY.find((e) => e.key === 'tracking-allow-reconcile');
    const schedule = entry?.worker.schedules[0];
    return schedule?.kind === 'interval' && schedule.source === 'TRACKING_ALLOW_RECONCILE_INTERVAL_MS';
});

assert('analytics-aggregation is registered AND triggerable', () =>
    WORKER_KEYS.includes('analytics-aggregation' as never)
    && WORKER_INVENTORY.some((e) => e.key === 'analytics-aggregation' && e.triggerable));

assert('its schedule is derived from ANALYTICS_AGGREGATION_CRON, not a literal', () => {
    const entry = WORKER_INVENTORY.find((e) => e.key === 'analytics-aggregation');
    const schedule = entry?.worker.schedules[0];
    return schedule?.kind === 'cron' && schedule.source === 'ANALYTICS_AGGREGATION_CRON';
});

// ═══ Worker overlap lock (F-19) ═══════════════════════════════════════════════

/**
 * The defect: nine of the thirteen workers could start a pass while the previous pass was still
 * running. `executing` made that visible and deliberately did not prevent it.
 *
 * Two things are asserted here, and the second is the one that lasts. The behaviour tests drive
 * `withWorkerLock` directly with the Redis layer switched off, so they prove the in-process floor
 * — the layer that must hold with no Redis at all. The SOURCE SCAN then proves every worker
 * actually routes through it: a guard nobody calls protects nothing, which is exactly the state
 * `requireActiveUser` and the password-epoch predicate were both found in. That example is
 * historical as of 2026-08-19: `auth/guards/` was deleted in Phase 4 for precisely that reason.
 */
section('Worker overlap lock — the guard, and that every worker uses it');

/**
 * Every file that schedules recurring work must take the lock.
 *
 * Keyed on the file naming convention rather than a hand-kept list, so a worker added next year
 * is covered by construction — which is the failure mode that produced this defect's own
 * miscount: the audit said "seven cron workers" from a docstring written before two more existed.
 */
const WORKER_SOURCES = [
    ...readSources(join(SRC, 'modules')).filter(({ file }) => file.endsWith('.worker.ts')),
    { file: 'aggregation-scheduler.ts', code: stripComments(
        readFileSync(join(SRC, 'core', 'jobs', 'aggregation-scheduler.ts'), 'utf8')) },
];

assert('the scan sees every worker file — 18 module workers plus the scheduler', () =>
    WORKER_SOURCES.length === 19);

assert('EVERY worker routes its pass through withWorkerLock', () => {
    const missing = WORKER_SOURCES.filter(({ code }) => !code.includes('withWorkerLock('));
    if (missing.length > 0) originalConsole.log('    unguarded:', missing.map((m) => m.file));
    return missing.length === 0;
});

/**
 * The bespoke boolean guards the four already-protected workers used are gone, not layered.
 *
 * Two guards for one rule is how they drift: the shared one gains a behaviour (the cross-instance
 * half, the skip metric) and the local one silently keeps returning early before it is reached.
 *
 * ⚠ `running` is deliberately NOT in this pattern, and the reason is the three-meanings-of-running
 * mess `ObservableWorker` documents. In the two booking workers `this.running` means "start() was
 * called", and `if (this.running) return` inside `start()` is a correct idempotence guard that
 * must stay. Only the unambiguous in-flight flags are scanned; a bespoke guard re-added on a field
 * named `running` would slip past, which is a known and stated gap rather than an assumed one.
 */
assert('no worker still short-circuits on its own in-flight flag', () => {
    const local = WORKER_SOURCES.filter(({ code }) =>
        /if\s*\(\s*this\.(sweeping|inFlight|nearSyncing|farSyncing)\s*\)\s*return/.test(code));
    if (local.length > 0) originalConsole.log('    bespoke guard:', local.map((m) => m.file));
    return local.length === 0;
});

/**
 * `executing` must stay an observation. A worker that derived it from the lock could not report
 * "idle here, but refused because another instance holds it" — a state an operator staring at a
 * stalled queue needs to be able to see.
 */
assert('no worker derives `executing` from the lock', () =>
    WORKER_SOURCES.every(({ code }) =>
        !/get executing[\s\S]{0,120}(locksHeldInProcess|withWorkerLock)/.test(code)));

// ═══ Graceful shutdown (plan step 2.A) ════════════════════════════════════════

/**
 * The drain stops workers by ITERATING the inventory, so what has to be asserted is that the
 * inventory is COMPLETE — not that some stop list is.
 *
 * `ObservableWorker` now declares `stop()`, so "every inventoried worker can be stopped" is a
 * compile error the moment it stops being true and needs no test here. The gap the type system
 * cannot see is a worker that EXISTS and was never inventoried — and that is not hypothetical:
 * `AssignmentSweepWorker` sat in exactly that state for a phase, because the registry was
 * written from `server.ts`'s import block and that worker starts indirectly through
 * `initializeShipmentAssignment()`.
 *
 * Uninventoried now means unstopped, and an unstopped sweep outlives the drain — holding a
 * Redis lock, writing to a connection that is closing.
 */
section('Graceful shutdown — the inventory IS the stop list, so it must be complete');

assert('every worker source file has an inventory entry — the counts are coupled', () =>
    WORKER_SOURCES.length === WORKER_INVENTORY.length);

/**
 * And by name, not only by count: two workers added and one entry deleted keeps the numbers
 * equal while leaving one of them unstopped.
 */
assert('the registry imports a singleton from every worker source file', () => {
    const registry = readFileSync(join(SRC, 'modules', 'dev-tools', 'worker-registry.ts'), 'utf8');
    const orphans = WORKER_SOURCES.filter(({ code }) => {
        const singletons = [...code.matchAll(/export const (\w*[Ww]orker)\b/g)].map((m) => m[1]);
        return singletons.length > 0 && !singletons.some((name) => registry.includes(name));
    });
    if (orphans.length > 0) {
        originalConsole.log('    not reachable from the registry:', orphans.map((o) => o.file));
    }
    return orphans.length === 0;
});

/**
 * The drain's ORDER, asserted from source because getting it wrong is invisible in a passing
 * boot. A timer that fires after Mongo closes throws inside a callback with no handler above
 * it, which takes the process down MID-DRAIN — turning the clean shutdown into the abrupt one
 * it exists to prevent.
 */
const LIFECYCLE_SRC = stripComments(readFileSync(join(SRC, 'lifecycle.ts'), 'utf8'));

assert('drain() stops the workers BEFORE it disconnects Mongo', () => {
    const stop = LIFECYCLE_SRC.indexOf('stopAllWorkers(');
    const disconnect = LIFECYCLE_SRC.indexOf('mongoose.disconnect(');
    return stop > -1 && disconnect > -1 && stop < disconnect;
});

assert('drain() flushes the log sink BEFORE Mongo closes — that sink writes to Mongo', () => {
    const flush = LIFECYCLE_SRC.indexOf('logMongoSink.flush(');
    const disconnect = LIFECYCLE_SRC.indexOf('mongoose.disconnect(');
    return flush > -1 && disconnect > -1 && flush < disconnect;
});

/**
 * `server.close()` alone waits for every open socket, and a keep-alive socket idling between
 * requests never closes on its own — so without this the drain reliably hits its deadline and
 * force-exits, which is the abrupt termination again, arrived at slowly.
 */
assert('the listener is closed with closeIdleConnections()', () =>
    LIFECYCLE_SRC.includes('closeIdleConnections('));

assert('the keep-alive headers timeout EXCEEDS the keep-alive timeout', () => {
    const keepAlive = /keepAliveTimeout\s*=\s*([\d_]+)/.exec(LIFECYCLE_SRC);
    const headers = /headersTimeout\s*=\s*([\d_]+)/.exec(LIFECYCLE_SRC);
    if (!keepAlive || !headers) return false;
    return Number(headers[1].replace(/_/g, '')) > Number(keepAlive[1].replace(/_/g, ''));
});

/**
 * Exactly one place in `src/` handles a signal.
 *
 * Two partial handlers used to exist — the log sink's `SIGTERM` flush and the calendar
 * worker's self-stop. Once a real drain exists those are not a partial version of it but a
 * RACE against it: both fire concurrently, and the first lands a Mongo write on the connection
 * the drain is closing.
 *
 * `beforeExit` is deliberately not scanned. It cannot fire on a signal or on `process.exit()`,
 * so it covers the one way out that `lifecycle.ts` never sees.
 */
assert('lifecycle.ts is the ONLY signal handler in src/', () => {
    const offenders = readSources(SRC).filter(({ file, code }) =>
        !file.endsWith('lifecycle.ts')
        && /process\.(on|once)\(\s*['"]SIG(TERM|INT)['"]/.test(code));
    if (offenders.length > 0) {
        originalConsole.log('    competing handler:', offenders.map((o) => o.file));
    }
    return offenders.length === 0;
});


/**
 * ── Runtime assets `tsc` does not emit ───────────────────────────────────────
 *
 * `tsc` emits `.js` and, via `resolveJsonModule`, any imported `.json`. Nothing else.
 * So a file read off disk at runtime through a `__dirname`-relative path lives in
 * `src/` and never reaches `dist/`, and the two run paths silently disagree:
 * `npm run dev` resolves it, `npm start` — and every container image — does not.
 *
 * The six Handlebars mail templates were in exactly that state until plan step 2.B.1:
 * `mail.service.ts` reads `__dirname/templates/<name>.hbs`, `dist/modules/mail/` had no
 * `templates/`, and every templated email threw MAIL_TEMPLATE_NOT_FOUND in any deploy
 * that ran the build. `npm run typecheck` passes on it, because it is not a type error.
 *
 * `scripts/copy-build-assets.ts` now copies them, from an explicit manifest. This scan
 * is what keeps the manifest honest: a NEW asset extension appearing under `src/` must
 * either be covered by the manifest or be added to the ignore list below with a reason.
 * A glob-everything copy was rejected — `src/` also holds READMEs and a stray test PDF,
 * and none of that belongs in a runtime image.
 */
const BUILD_ASSETS_SRC = readFileSync(join(__dirname, '..', 'copy-build-assets.ts'), 'utf8');

/** Extensions that are documentation or fixtures, never read by the running service. */
const NON_RUNTIME_EXTENSIONS = new Set(['.pdf']);

/**
 * The `.md` files under `src/` that really are documentation.
 *
 * `.md` used to sit in NON_RUNTIME_EXTENSIONS, on the assumption that markdown under
 * `src/` is always a README. That assumption held until the negotiation playbook, which
 * IS read off disk at runtime - so it would have been absent from `dist/` under
 * `npm start`, and the one guard written to catch exactly that would have skipped it.
 *
 * An allowlist rather than an extension skip: a NEW runtime `.md` fails this suite until
 * somebody classifies it, which is the same argument the manifest itself makes against a
 * glob. Adding a README here is a claim that nothing reads it.
 */
const DOCUMENTATION_MARKDOWN = new Set([
    'core/storage/README.md',
    'core/uploads/README.md',
    'modules/whatsapp/EXAMPLES.md',
    'modules/whatsapp/README.md',
]);

/** `tsc` emits these itself, so they need no manifest entry. */
const EMITTED_BY_TSC = new Set(['.ts', '.json']);

function collectAssetFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // `src/scripts/` is gitignored one-off tooling, excluded from the build and from
        // test:env's census for the same reason. It is not part of the shipped service.
        if (entry.isDirectory()) {
            if (entry.name !== 'scripts' || dir !== SRC) collectAssetFiles(full, out);
            continue;
        }
        const dot = entry.name.lastIndexOf('.');
        const ext = dot === -1 ? '' : entry.name.slice(dot);
        if (EMITTED_BY_TSC.has(ext) || NON_RUNTIME_EXTENSIONS.has(ext)) continue;
        if (ext === '.md' && DOCUMENTATION_MARKDOWN.has(relative(SRC, full).split(sep).join('/'))) continue;
        out.push(full);
    }
    return out;
}

assert('every non-emitted asset under src/ is covered by the build-assets manifest', () => {
    const uncovered = collectAssetFiles(SRC)
        // `src/storage-test/` is an upload fixture, not a runtime asset.
        .filter((file) => !file.includes(`${sep}storage-test${sep}`))
        .filter((file) => {
            const rel = relative(SRC, file).split(sep).join('/');
            const dir = rel.slice(0, rel.lastIndexOf('/'));

            /**
             * ⚠ **A manifest entry covers its SUBDIRECTORIES too**, and this used to compare
             * the exact directory only.
             *
             * `copy-build-assets.ts` copies with `cpSync(from, to, { recursive: true })`, so
             * `modules/mail/templates` already carries `modules/mail/templates/partials` into
             * `dist/`. The old exact match reported those files as uncovered — a FALSE
             * POSITIVE, and the expensive kind: the obvious response is to add the
             * subdirectory to the manifest, which copies it twice, or to move the files, which
             * is a real change made to satisfy a wrong test.
             *
             * Walking up the path mirrors what the copier actually does. The check keeps its
             * teeth for the case it exists for — an asset under a directory NO entry covers,
             * which is how six Handlebars templates were absent from every container image.
             */
            const covered = dir
                .split('/')
                .some((_, i, parts) => BUILD_ASSETS_SRC.includes(`'${parts.slice(0, i + 1).join('/')}'`));

            return !covered;
        });
    if (uncovered.length > 0) {
        originalConsole.log('    not copied into dist/:', uncovered.map((f) => relative(SRC, f)));
    }
    return uncovered.length === 0;
});

assert('the mail templates specifically are in the manifest — they are the known case', () =>
    BUILD_ASSETS_SRC.includes("'modules/mail/templates'"));

/**
 * ── `GET /api/health` IS FROZEN, AND THIS IS WHAT FREEZES IT ─────────────────
 *
 * `health.routes.ts`'s header has claimed for some time that "`npm run test:system`
 * asserts the path and the body keys". It did not. What existed was the MAINTENANCE
 * exemption for that path, above — a different property entirely. A comment asserting
 * the existence of a test that does not exist is worse than no comment: it is the
 * reason somebody skips writing the test. (Plan step 2.B.6; correction #2.)
 *
 * Three consumers depend on the exact shape, and one of them turns a change here into
 * an outage somewhere else:
 *
 *   • geo-tracker's `NodeAPIChecker` GETs this path via NODE_API_HEALTH_PATH and is
 *     registered as a READINESS checker on its own /readyz. Its client treats any
 *     status >= 300 as an error and never parses the body, so ONLY the status code is
 *     load-bearing there — and readiness semantics on this path mean a jovi-mall Redis
 *     wobble depools geo-tracker and kills every live WebSocket tracking session.
 *   • wi-admin's `pingPlatform()` surfaces it on /health/ready and /api/v1/system/health.
 *   • Docker's HEALTHCHECK in the two images, and the compose stack.
 *
 * The handler is invoked DIRECTLY off the router's own layer stack rather than over
 * HTTP: it proves the registered PATH and the handler together, with no server and no
 * database. `/ready` is deliberately not invoked here — it probes Mongo and Redis.
 */
const healthLayers = (healthRoutes as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandlerLike }> } }>;
}).stack.filter((layer) => layer.route);

function invokeHealthRoute(path: string): { status: number; body: Record<string, unknown> } {
    const layer = healthLayers.find((l) => l.route!.path === path);
    if (!layer) throw new Error(`no route registered at ${path}`);

    let status = 200;
    const res = {
        status(code: number) { status = code; return this; },
        json(payload: Record<string, unknown>) { this.__body = payload; return this; },
        __body: {} as Record<string, unknown>,
    };
    layer.route!.stack[0].handle({} as never, res as never, (() => undefined) as never);
    return { status, body: res.__body };
}

assert('the frozen path is registered at exactly `/` on the health router', () =>
    healthLayers.some((l) => l.route!.path === '/' && l.route!.methods.get === true));

assert('GET /api/health answers 200 UNCONDITIONALLY — it touches no dependency', () =>
    invokeHealthRoute('/').status === 200);

assert('…with exactly the keys {status, timestamp} and status "ok"', () => {
    const { body } = invokeHealthRoute('/');
    const keys = Object.keys(body).sort();
    return keys.length === 2
        && keys[0] === 'status' && keys[1] === 'timestamp'
        && body.status === 'ok'
        && typeof body.timestamp === 'string'
        && !Number.isNaN(Date.parse(body.timestamp as string));
});

// The body is NOT wrapped in the house `{success, data}` envelope, and that is the
// contract rather than an oversight — geo-tracker and wi-admin parse this shape.
assert('the frozen body is UNWRAPPED — no success/data envelope', () => {
    const { body } = invokeHealthRoute('/');
    return !('success' in body) && !('data' in body);
});

// The liveness probe is a SEPARATE endpoint, and both images' HEALTHCHECK points at it
// rather than at the frozen path — one fewer consumer on a contract three services
// already depend on.
assert('/live exists beside it and reports the service by name', () => {
    const { status, body } = invokeHealthRoute('/live');
    return status === 200 && body.status === 'alive' && body.service === 'jovi-mall';
});

assert('/ready is registered — readiness lives HERE, never on the frozen path', () =>
    healthLayers.some((l) => l.route!.path === '/ready'));

// The rate-limit half is asserted in `test:errors`, which owns that module. This one
// line couples the two: the frozen path being exempt is a property of THIS contract,
// and a reader of health.routes.ts should find it proven from here too.
assert('the frozen path is exempt from rate limiting — a 429 is a >= 300 to geo-tracker', () =>
    isExemptPathname('/api/health') && isExemptPathname('/api/health/ready'));

/**
 * ── The migration ledger (plan step 2.C) ─────────────────────────────────────
 *
 * Fifteen idempotent migration programs existed with no record of what had been applied
 * where. Two properties are asserted here, and each closes one half of that.
 *
 * **The registry is closed.** `assertRegistryCovers()` diffs `MIGRATIONS` against every
 * `migrate:*` / `backfill:*` binding in package.json. Run from the suite rather than only
 * from whoever happens to type `migrate:status` next, because a migration added
 * without a row is a migration the ledger silently does not track — which is precisely the
 * state this part was written to end.
 *
 * **`changed` is not `applied`.** The checksum is the whole reason the ledger stores one,
 * and the exit criterion for the part is written in terms of it: a migration edited since
 * it ran must report as such. `resolveMigrationStatus` is pure and lives in `src/`, so it
 * is driven here from literals.
 */
section('Migration ledger — the registry is closed, and an edit is not an application');

assert('MIGRATIONS covers every migrate:*/backfill:* binding, and every row has a file', () => {
    assertRegistryCovers();   // throws with the drift named
    return true;
});

// 17 → 18 at Phase 5 Part E: `migrate:retire-admin-role`, which pulls the legacy `admin` role
// off `users` rows and suspends any row that carried nothing else. The pair with `auth.service`'s
// new role filter is the point — the guard stops new admin tokens being minted, this removes the
// rows a future regression would mint them from.
//
// 18 → 20 in Phase 6, and both additions are index builds whose UNIQUE half is load-bearing
// rather than an optimisation — with `autoIndex` off in production, an unbuilt one means the
// uniqueness the code upserts against is enforced by nothing:
//   `migrate:review-indexes`           (6.E.4) one review per author per subject
//   `migrate:customer-catalog-indexes` (6.E.1 / 6.E.2) one wishlist / recently-viewed row per
//                                      (customer, product)
//
// 20 → 21 at Step 14: `migrate:inventory-indexes`, same argument again and the sharpest case
// of it — `stock_movement_idempotency` is what stops a retried payment webhook selling the same
// depot shelf twice, and `storage_invoice_identity` is what stops the monthly run issuing two
// statements for one month.
// 21 -> 22: `migrate:booking-number-index`, the partial unique index on
// `bookings.bookingNumber`. Same argument a fourth time — the booking handle's
// uniqueness is enforced by that index and by `BookingNumberGenerator`'s counter,
// and a restored database that lost the counter re-issues numbers customers are
// already holding, silently.
// 22 -> 23: `migrate:plan-quota-indexes`. Two ordering indexes the plan-quota sweep walks
// (on `products` and `files`), plus the UNIQUE stamp on `plan_quota_states` — the fifth
// migration here to claim uniqueness, and for the same class of reason: without it two
// sweeps can each believe they enforced the current plan while disagreeing about which one
// it is.
// ⚠ THE RUNNING COMMENTARY ABOVE IS ONE AHEAD OF THE ARRAY, and was before this row was
// added: the chain ends "22 -> 23: migrate:plan-quota-indexes" while `MIGRATIONS` held 22
// and this assert said 22. One of the increments between 17 and 22 double-counts; which one
// is not recoverable from the text, and chasing it would be guessing. Left as history, with
// the drift named — the ASSERT is what is checked, and the runner's own header already says
// why: "a number in a comment proves nothing and is one more thing to forget."
//
// Measured, not counted by eye: 22 -> 23 with `migrate:declared-indexes`.
//
// It is a different KIND of row from the five uniqueness arguments above — the catch-all
// rather than another named handful. The first production deploy (2026-09-13) measured what
// the twenty-two between them do NOT cover, from `reportIndexDrift()`'s own boot log: 389
// declared indexes missing before `migrate:up`, 350 still missing after it. So every
// migration written to date accounts for 39, and the other 350 existed only because
// `autoIndex` builds them in development and nothing builds them in production.
//
// 83 of the 396 declared indexes are UNIQUE — measured by the migration's own `--dry-run`
// against an empty database, not counted by eye, and four times the "about twenty" the work
// started from. That makes the sixth uniqueness argument in this list also much the largest:
// one wallet per owner, one COD collection per shipment, SKU uniqueness, one channel identity
// per account.
assert('all twenty-three are registered — the count is the count on disk', () =>
    MIGRATIONS.length === 23);

// The catch-all is LAST, and unlike the general index-after-data rule below this is a
// dependency on the OTHER INDEX MIGRATIONS: it builds only what the declared-vs-live diff
// reports missing, so the named indexes the rows above create have to exist by the time it
// diffs. Running it earlier would create those keys under Mongoose's default names and
// leave the named builds to collide with them (IndexOptionsConflict, 85).
assert('migrate:declared-indexes is the last migration of all', () =>
    MIGRATIONS[MIGRATIONS.length - 1].name === 'migrate:declared-indexes');

// ONE ordering rule now, from the runner's own header, and it is correctness rather than
// taste: a unique index build fails outright against data a later migration has not yet
// cleaned up. The second rule ("migrate:agent-memberships FIRST") went with the migration
// itself — deleted 2026-08-23, Phase 6 Step 17, because it wrote the retired status
// literal `approved`. Nothing replaced it: no surviving data migration reads another's
// output. Its ledger row stays in schema_migrations as history and is not reported.
assert('migrate:agent-memberships is GONE — it wrote a retired ContractStatus', () =>
    !MIGRATIONS.some((m) => m.name === 'migrate:agent-memberships'));

// Classified on the FILE, not the binding: `migrate:admin-action-log` builds indexes
// (including a TTL) and its binding name does not say so, while its file —
// `migrate-admin-action-log-indexes.ts` — does. The file is what runs.
assert('every index migration runs after every data migration', () => {
    const isIndexBuild = (m: { file: string }): boolean => m.file.includes('index');
    const firstIndex = MIGRATIONS.findIndex(isIndexBuild);
    const lastData = MIGRATIONS.map(isIndexBuild).lastIndexOf(false);
    return firstIndex > -1 && firstIndex > lastData;
});

// Correction #4 to the plan: three of the fifteen had no --dry-run at all, so "a dry run is
// a safe read of current state" was not available for them. All of them have one now, and
// the runner's `dryRun` flag is what `migrate:up -- --dry-run` reads to decide whether it may
// rehearse a script or must skip it.
assert('every migration declares --dry-run, and every script actually accepts one', () => {
    const missing = MIGRATIONS.filter((m) => {
        if (!m.dryRun) return true;
        return !readFileSync(join(__dirname, '..', '..', m.file), 'utf8').includes('--dry-run');
    });
    if (missing.length > 0) {
        originalConsole.log('    no --dry-run:', missing.map((m) => m.name));
    }
    return missing.length === 0;
});

const ledgerRow = (checksum: string, outcome: 'success' | 'failed', at: string) =>
    ({ checksum, outcome, appliedAt: new Date(at) });

assert('no rows at all reads as not_applied', () =>
    resolveMigrationStatus([], 'aaa') === 'not_applied');

assert('a success at the current checksum reads as applied', () =>
    resolveMigrationStatus([ledgerRow('aaa', 'success', '2026-01-01')], 'aaa') === 'applied');

// THE exit criterion for plan part 2.C.
assert('a success at a DIFFERENT checksum reads as changed, never as applied', () =>
    resolveMigrationStatus([ledgerRow('aaa', 'success', '2026-01-01')], 'bbb') === 'changed');

assert('a failure with no success reads as failed, NOT as not_applied', () =>
    resolveMigrationStatus([ledgerRow('aaa', 'failed', '2026-01-01')], 'aaa') === 'failed');

// The two orderings that a naive "newest row wins" or "any success wins" gets wrong.
assert('a failure AFTER a success at the same checksum reads as failed', () =>
    resolveMigrationStatus([
        ledgerRow('aaa', 'success', '2026-01-01'),
        ledgerRow('aaa', 'failed', '2026-02-01'),
    ], 'aaa') === 'failed');

assert('a success AFTER a failure at the same checksum reads as applied', () =>
    resolveMigrationStatus([
        ledgerRow('aaa', 'failed', '2026-01-01'),
        ledgerRow('aaa', 'success', '2026-02-01'),
    ], 'aaa') === 'applied');

// Edited, run, failed, then reverted: the version on disk DID succeed once, so it is applied.
assert('a failure at a checksum nobody is on any more does not mask an applied version', () =>
    resolveMigrationStatus([
        ledgerRow('aaa', 'success', '2026-01-01'),
        ledgerRow('bbb', 'failed', '2026-02-01'),
    ], 'aaa') === 'applied');

assert('applied is the ONLY state migrate:up skips', () =>
    !needsApplying('applied')
    && (['not_applied', 'changed', 'failed'] as const).every((s) => needsApplying(s)));

/**
 * `autoIndex` is off in production now, and that trades a silent-SLOW failure for a
 * silent-MISSING one. Both halves of 2.C.4 are asserted from source: without the second,
 * a declared index nobody built simply is not there and nothing says so.
 */
assert('mongoose.connect sets autoIndex off in production', () =>
    /autoIndex:\s*process\.env\.NODE_ENV\s*!==\s*'production'/.test(LIFECYCLE_SRC));

assert('boot reports index drift — the other half of turning autoIndex off', () =>
    LIFECYCLE_SRC.includes('reportIndexDrift(') && LIFECYCLE_SRC.includes('inspectDatabase('));

// It must not be awaited: `inspectDatabase` walks the whole collection registry under a
// wall-clock budget, and none of it is a precondition for serving a request. Awaiting it
// would add that budget to every boot and every rolling-deploy step.
assert('the drift report is fired off, not awaited', () =>
    LIFECYCLE_SRC.includes('void reportIndexDrift()'));

void (async () => {
    // The in-process floor, proven without a Redis to talk to. See `redisLayerEnabled`.
    process.env.WORKER_LOCK_REDIS = 'false';
    __resetWorkerLocksForTest();

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    let concurrent = 0;
    let peak = 0;
    const body = async (): Promise<string> => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await settle();
        concurrent -= 1;
        return 'ran';
    };

    const [first, second] = await Promise.all([
        withWorkerLock('test-sweep', body),
        withWorkerLock('test-sweep', body),
    ]);

    assert('two concurrent passes never overlap — exactly one body runs', () => peak === 1);

    assert('the loser is SWEEP_SKIPPED, not a fake result', () =>
        (first === 'ran' && second === SWEEP_SKIPPED)
        || (second === 'ran' && first === SWEEP_SKIPPED));

    // Awaited OUT here, then asserted synchronously: `assert` takes `() => boolean`, so handing
    // it an async callback would pass it a Promise — always truthy, always green, never a test.
    const afterRelease = await withWorkerLock('test-sweep', body);
    assert('the key is released afterwards, so the next tick runs', () => afterRelease === 'ran');

    const distinctKeys = await Promise.all([
        withWorkerLock('sweep-a', body),
        withWorkerLock('sweep-b', body),
    ]);
    assert('a different key is not blocked — the lock is per worker, not global', () =>
        distinctKeys.every((r) => r === 'ran'));

    /**
     * The `finally` matters more than it looks: a sweep that throws and leaves its key held makes
     * the worker permanently unrunnable until the process restarts — the same trap
     * `POST /dev-tools/workers/:key/run` avoids with its own `finally` around `releaseWorker`.
     */
    let threw = false;
    // `Promise.reject`, not `throw new Error` — same observable behaviour from an async body, and
    // it does not add a third violation of this repo's `no-restricted-syntax` ban to this file.
    await withWorkerLock('sweep-throws', () => Promise.reject(new Error('boom')))
        .catch(() => { threw = true; });
    const afterThrow = await withWorkerLock('sweep-throws', body);
    assert('the body\'s error propagates rather than being swallowed', () => threw);
    assert('a throwing body still releases the key', () => afterThrow === 'ran');

    const passthrough = await withWorkerLock('sweep-value', async () => 42);
    assert('the body\'s return value is passed straight through', () => passthrough === 42);

    __resetWorkerLocksForTest();
    delete process.env.WORKER_LOCK_REDIS;

    const metrics = await metricsRegistry().getMetricsAsJSON();

    assert('every instrument is prefixed jovimall_', () =>
        metrics.every((metric) => metric.name.startsWith('jovimall_')));

    /**
     * The buckets, asserted through the exposition — which needs an observation first, because
     * prom-client emits no bucket rows for a histogram nobody has touched.
     *
     * Worth doing properly rather than checking a field exists: a histogram with no declared
     * buckets silently falls back to prom-client's web-request defaults, which top out at 10
     * seconds. `worker_duration_seconds` measures sweeps that run for **minutes** — every one of
     * them would land in `+Inf` and the metric would carry no information whatsoever, while
     * looking perfectly healthy. So this asserts the ceiling is where it was declared.
     */
    httpRequestDuration.observe({ method: 'GET', route_group: '/api/products' }, 0.01);
    workerDuration.observe({ worker: 'plan-expiry' }, 1);
    integrationDuration.observe({ provider: 'geo_tracker' }, 0.1);

    const observed = await metricsRegistry().getMetricsAsJSON();
    const boundariesOf = (name: string): number[] => {
        const metric = observed.find((m) => m.name === name);
        const values = (metric as { values?: Array<{ labels?: Record<string, unknown> }> } | undefined)?.values ?? [];
        return values
            .map((v) => v.labels?.le)
            .filter((le): le is number => typeof le === 'number');
    };

    assert('our histograms declare explicit buckets', () =>
        ['jovimall_http_request_duration_seconds',
            'jovimall_worker_duration_seconds',
            'jovimall_integration_duration_seconds',
        ].every((name) => boundariesOf(name).length > 0));

    assert('worker buckets reach 900s — prom-client\'s 10s default would flatten every sweep', () =>
        Math.max(...boundariesOf('jovimall_worker_duration_seconds')) === 900);

    assert('HTTP buckets stay in web-request range', () =>
        Math.max(...boundariesOf('jovimall_http_request_duration_seconds')) === 10);

    assert('the core instruments are all registered', () =>
        ['jovimall_http_requests_total',
            'jovimall_http_request_duration_seconds',
            'jovimall_worker_runs_total',
            'jovimall_worker_last_success_timestamp_seconds',
            'jovimall_outbox_depth',
            'jovimall_integration_calls_total',
            'jovimall_maintenance_mode',
        ].every((name) => metrics.some((metric) => metric.name === name)));

    // Node process metrics do not come free the way Go's client gives geo-tracker its own —
    // and event-loop lag is the single most useful Node-specific signal here.
    assert('default process metrics are collected onto the private registry', () =>
        metrics.some((metric) => metric.name === 'jovimall_nodejs_eventloop_lag_seconds'));

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
