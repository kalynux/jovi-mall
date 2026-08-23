import {
    Counter,
    Gauge,
    Histogram,
    Registry,
    collectDefaultMetrics,
} from 'prom-client';
import { installRedisErrorSink, REDIS_DB_CATALOG } from '../../../infra/redis/redis.factory';
import { SYSTEM_CONFIG } from '../config/system.config';
import { assertRouteGroupsBounded } from '../domain/route-group';

/**
 * The metrics registry — **private**, exactly as geo-tracker's
 * `internal/platform/metrics/metrics.go` builds its own `prometheus.NewRegistry()`.
 *
 * Never prom-client's global `register`. Two reasons, and they are the same two geo-tracker's
 * header gives: every instrument is defined in one file so there is one place to look, and a
 * test can construct an isolated registry without a previous test's counters bleeding into it.
 * `npm run test:system` asserts that nothing here reached the global registry.
 *
 * Prefix `jovimall_`, mirroring `geotracker_`.
 */
const registry = new Registry();

/** Node process metrics. Go gives geo-tracker these for free; Node needs the explicit call. */
let defaultsCollected = false;

const PREFIX = 'jovimall_';

// ─── HTTP ─────────────────────────────────────────────────────────────────────
//
// `route_group` and `status_class`, never `route` and `status` — see `domain/route-group.ts`
// for why the label space has to be closed rather than merely normalised.

export const httpRequestsTotal = new Counter({
    name: `${PREFIX}http_requests_total`,
    help: 'HTTP requests by method, route group and status class',
    labelNames: ['method', 'route_group', 'status_class'] as const,
    registers: [registry],
});

export const httpRequestDuration = new Histogram({
    name: `${PREFIX}http_request_duration_seconds`,
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route_group'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
    name: `${PREFIX}http_requests_in_flight`,
    help: 'HTTP requests currently being served',
    registers: [registry],
});

// ─── Workers ──────────────────────────────────────────────────────────────────

export const workerRunsTotal = new Counter({
    name: `${PREFIX}worker_runs_total`,
    help: 'Background worker passes by trigger and outcome',
    labelNames: ['worker', 'trigger', 'outcome'] as const,
    registers: [registry],
});

export const workerDuration = new Histogram({
    name: `${PREFIX}worker_duration_seconds`,
    help: 'Background worker pass duration in seconds',
    labelNames: ['worker'] as const,
    // Sweeps run for minutes, not milliseconds. The HTTP buckets would put every run in +Inf.
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
    registers: [registry],
});

/**
 * The single most useful worker signal.
 *
 * A daily sweep that stopped forty hours ago is invisible to a counter — the count simply stops
 * rising, which looks identical to a quiet period. Against this gauge it is one obvious
 * `time() - jovimall_worker_last_success_timestamp_seconds > 86400` alert.
 */
export const workerLastSuccess = new Gauge({
    name: `${PREFIX}worker_last_success_timestamp_seconds`,
    help: 'Unix timestamp of the last successful pass, per worker',
    labelNames: ['worker'] as const,
    registers: [registry],
});

export const workerProcessedTotal = new Counter({
    name: `${PREFIX}worker_processed_total`,
    help: 'Items handled by background workers that report a count',
    labelNames: ['worker'] as const,
    registers: [registry],
});

// ─── Outbox ───────────────────────────────────────────────────────────────────

export const outboxDispatchedTotal = new Counter({
    name: `${PREFIX}outbox_dispatched_total`,
    help: 'Tracking outbox rows dispatched, by event type and outcome',
    labelNames: ['type', 'outcome'] as const,
    registers: [registry],
});

// ─── Event bus ────────────────────────────────────────────────────────────────

export const eventBusPublishedTotal = new Counter({
    name: `${PREFIX}event_bus_published_total`,
    help: 'Domain events published, by type',
    labelNames: ['event_type'] as const,
    registers: [registry],
});

export const eventBusHandlerFailuresTotal = new Counter({
    name: `${PREFIX}event_bus_handler_failures_total`,
    help: 'Domain event handlers that threw, by type',
    labelNames: ['event_type'] as const,
    registers: [registry],
});

// ─── Integrations ─────────────────────────────────────────────────────────────

export const integrationCallsTotal = new Counter({
    name: `${PREFIX}integration_calls_total`,
    help: 'Outbound integration calls, by provider and outcome',
    labelNames: ['provider', 'outcome'] as const,
    registers: [registry],
});

/**
 * The geocoding cache's hit rate — ADR-A04 D-1, and the instrument D-2 asks for by name.
 *
 * D-2 defers self-hosting until "the cache's hit rate stops rising and the miss volume justifies
 * it". That is a measurement, and this is the only place it can come from. Two labels would have
 * been the obvious shape (`op` × `event`); one is enough, because the decision is about the cache
 * as a whole and `route_group` already separates `/api/geo/search` from `/api/geo/reverse` on the
 * HTTP counter.
 *
 * `event` is a CLOSED set of five — hit · miss · store · bypass · error — declared in
 * `core/geocoding/geocoding.cache.ts`. Never label this by query: an address is user input and
 * would be unbounded cardinality carrying personal data, which is the rule
 * `domain/route-group.ts` states for every label here.
 */
export const geocodingCacheEventsTotal = new Counter({
    name: `${PREFIX}geocoding_cache_events_total`,
    help: 'Geocoding cache outcomes (hit, miss, store, bypass, error)',
    labelNames: ['event'] as const,
    registers: [registry],
});

export const integrationDuration = new Histogram({
    name: `${PREFIX}integration_duration_seconds`,
    help: 'Outbound integration call duration in seconds',
    labelNames: ['provider'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
});

// ─── Infrastructure errors ────────────────────────────────────────────────────

/**
 * ⚠ **Connection-level only, on both of these.**
 *
 * Redis command errors are thrown to their caller and never pass through the client's `error`
 * event; Mongo query errors are caught by the schema-level post-hook but a driver call made
 * outside Mongoose is not. Stated here and in `api-doc/admin/system.md` rather than left to be
 * discovered — a counter that silently under-reports is worse than no counter, because somebody
 * will read zero as "no errors".
 */
export const redisOperationErrorsTotal = new Counter({
    name: `${PREFIX}redis_operation_errors_total`,
    help: 'Redis connection-level errors, by logical database (does NOT include command errors)',
    labelNames: ['db'] as const,
    registers: [registry],
});

export const mongoOperationErrorsTotal = new Counter({
    name: `${PREFIX}mongo_operation_errors_total`,
    help: 'MongoDB errors, by scope',
    labelNames: ['scope'] as const,
    registers: [registry],
});

// ─── Errors and rate limiting (Phase 16) ──────────────────────────────────────

/**
 * Every error that leaves through the global handler, by taxonomy value.
 *
 * Bounded by construction: 9 categories × 5 status classes = **45 series maximum**.
 *
 * Deliberately NOT labelled by route. `httpRequestsTotal` already carries `route_group`, so
 * a route label here would answer no new question and multiply the series by the size of
 * the allowlist — and `route-group.ts` exists precisely because prom-client enforces no
 * cardinality cap of its own. Never label this by code either: the registry has 541 entries
 * and grows.
 */
export const errorsTotal = new Counter({
    name: `${PREFIX}errors_total`,
    help: 'Errors returned to clients, by taxonomy category and status class',
    labelNames: ['category', 'status_class'] as const,
    registers: [registry],
});

/**
 * Requests refused by the rate limiter, by caller class and which policy fired.
 *
 * This is the number that turns the ceilings in `rate-limit/policy.ts` from a guess into a
 * measurement. They were chosen to be unreachable by any real user; if this counter is
 * non-zero for a class other than `anonymous`, either the guess was wrong or something is
 * looping, and the labels say which.
 *
 * 7 classes × 6 policies (global, identity, auth, auth_session, public, connection_code)
 * = 42 series. The policy set is closed and lives in `rate-limit/policy.ts`; keep this count
 * in step with `POLICIES` rather than with memory — it has now been stale twice.
 */
export const rateLimitedTotal = new Counter({
    name: `${PREFIX}rate_limited_total`,
    help: 'Requests refused with 429, by caller class and policy',
    labelNames: ['caller_class', 'policy'] as const,
    registers: [registry],
});

/**
 * Rate-limit store failures — the visibility half of failing open.
 *
 * When Redis is unreachable the limiter admits every request rather than rejecting every
 * request (see `rate-limit/fail-open-store.ts`). That is the right direction and it is also
 * a silent loss of a security control, so it is counted. A non-zero rate here means the
 * platform is currently unlimited.
 */
export const rateLimitStoreErrorsTotal = new Counter({
    name: `${PREFIX}rate_limit_store_errors_total`,
    help: 'Rate-limit store failures. Non-zero means the limiter is FAILING OPEN.',
    labelNames: ['operation'] as const,
    registers: [registry],
});

// ─── Maintenance ──────────────────────────────────────────────────────────────

/**
 * 0/1 per mode rather than a single number, so `jovimall_maintenance_mode{mode="down"} == 1`
 * is directly alertable — which is what you want for "still in maintenance after N minutes".
 */
export const maintenanceModeGauge = new Gauge({
    name: `${PREFIX}maintenance_mode`,
    help: 'Whether each maintenance mode is currently in force (1) or not (0)',
    labelNames: ['mode'] as const,
    registers: [registry],
});

// ─── Scrape-time collectors ───────────────────────────────────────────────────

/**
 * Outbox depth, computed **on scrape** rather than on a timer.
 *
 * A background poller would run the same Mongo aggregation whether or not anybody is scraping,
 * and this process already carries thirteen timers.
 *
 * ⚠ prom-client **awaits** a `collect` callback inside `registry.metrics()`, so a slow Mongo
 * would hang the scrape and, with a typical scrape timeout, make the endpoint look down while
 * the process is fine. Hence the race and the cached last value: a timeout serves the previous
 * numbers and counts itself, which is strictly more useful than an empty response.
 */
type OutboxDepthProvider = () => Promise<{ byStatus: Record<string, number>; oldestPendingAgeSeconds: number | null }>;

let outboxDepthProvider: OutboxDepthProvider | null = null;
let lastOutboxDepth: { byStatus: Record<string, number>; oldestPendingAgeSeconds: number | null } | null = null;
let lastOutboxDepthAt = 0;

export function installOutboxDepthProvider(provider: OutboxDepthProvider): void {
    outboxDepthProvider = provider;
}

export const outboxDepth = new Gauge({
    name: `${PREFIX}outbox_depth`,
    help: 'Tracking outbox rows by status',
    labelNames: ['status'] as const,
    registers: [registry],
    async collect() {
        const snapshot = await readOutboxDepth();
        if (!snapshot) return;
        for (const [status, count] of Object.entries(snapshot.byStatus)) {
            this.set({ status }, count);
        }
    },
});

export const outboxOldestPendingAge = new Gauge({
    name: `${PREFIX}outbox_oldest_pending_age_seconds`,
    help: 'Age of the oldest pending tracking-outbox row, in seconds',
    registers: [registry],
    async collect() {
        const snapshot = await readOutboxDepth();
        if (!snapshot) return;
        this.set(snapshot.oldestPendingAgeSeconds ?? 0);
    },
});

export const metricsCollectFailuresTotal = new Counter({
    name: `${PREFIX}metrics_collect_failures_total`,
    help: 'Scrape-time collectors that timed out or threw',
    labelNames: ['collector'] as const,
    registers: [registry],
});

async function readOutboxDepth() {
    if (!outboxDepthProvider) return null;

    const fresh = Date.now() - lastOutboxDepthAt < SYSTEM_CONFIG.METRICS_COLLECT_CACHE_MS;
    if (fresh && lastOutboxDepth) return lastOutboxDepth;

    try {
        const result = await Promise.race([
            outboxDepthProvider(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('collect timeout')), SYSTEM_CONFIG.METRICS_COLLECT_TIMEOUT_MS),
            ),
        ]);
        lastOutboxDepth = result;
        lastOutboxDepthAt = Date.now();
        return result;
    } catch {
        metricsCollectFailuresTotal.inc({ collector: 'outbox_depth' });
        // Serve the stale value rather than nothing — during the incident where Mongo is slow,
        // the last known backlog is exactly the number an operator wants.
        return lastOutboxDepth;
    }
}

// ─── Recorders ────────────────────────────────────────────────────────────────
//
// Call sites use these rather than touching instruments directly, so a label vocabulary change
// is one edit rather than a search.

export function recordRedisError(db: number): void {
    const spec = REDIS_DB_CATALOG.find((row) => row.db === db);
    redisOperationErrorsTotal.inc({ db: spec?.constant ?? `db${db}` });
}

export function recordMongoError(scope: string): void {
    mongoOperationErrorsTotal.inc({ scope });
}

/**
 * Count an error leaving the global handler.
 *
 * The status is collapsed to its class (`4xx`, `5xx`) rather than kept exact, which is the
 * whole reason the series count is bounded — and the exact status is already on
 * `httpRequestsTotal`.
 */
export function recordError(category: string, statusCode: number): void {
    errorsTotal.inc({ category, status_class: `${Math.floor(statusCode / 100)}xx` });
}

export function recordRateLimited(callerClass: string, policy: string): void {
    rateLimitedTotal.inc({ caller_class: callerClass, policy });
}

export function recordRateLimitStoreError(operation: string): void {
    rateLimitStoreErrorsTotal.inc({ operation });
}

/**
 * `skipped` is the third outcome, added with the F-19 overlap lock.
 *
 * Two properties of it are load-bearing, and both are about not lying to an alert:
 *
 *  - it does **not** observe a duration — a refused pass took microseconds, and feeding that into
 *    a histogram whose buckets reach 900s drags every percentile of a sweep that runs for minutes
 *    toward zero;
 *  - it does **not** advance `workerLastSuccess`. A worker skipping forever because a lock was
 *    orphaned is a worker that is not doing its job, and the documented
 *    `time() - last_success > 86400` alert must still fire for it. The lock makes overlap
 *    impossible; it must not also make the failure invisible.
 */
export function recordWorkerRun(
    worker: string,
    trigger: 'scheduled' | 'manual',
    outcome: 'success' | 'failure' | 'skipped',
    durationSeconds: number,
    processed?: number,
): void {
    workerRunsTotal.inc({ worker, trigger, outcome });
    if (outcome !== 'skipped') workerDuration.observe({ worker }, durationSeconds);
    if (outcome === 'success') workerLastSuccess.set({ worker }, Date.now() / 1000);
    if (typeof processed === 'number') workerProcessedTotal.inc({ worker }, processed);
}

export function setMaintenanceGauge(mode: 'off' | 'readonly' | 'down'): void {
    for (const candidate of ['off', 'readonly', 'down'] as const) {
        maintenanceModeGauge.set({ mode: candidate }, candidate === mode ? 1 : 0);
    }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Wire the registry into the rest of the process. Called once from `server.ts`, before the
 * listener opens and before any worker starts.
 */
export function initializeMetrics(): void {
    assertRouteGroupsBounded();

    if (!defaultsCollected) {
        // Event-loop lag is the single most useful Node-specific signal here and nothing else in
        // this codebase reports it.
        collectDefaultMetrics({ register: registry, prefix: PREFIX });
        defaultsCollected = true;
    }

    installRedisErrorSink(recordRedisError);
    setMaintenanceGauge('off');
}

export function metricsRegistry(): Registry {
    return registry;
}

/** Prometheus text exposition. */
export async function metricsText(): Promise<string> {
    return registry.metrics();
}

export function metricsContentType(): string {
    return registry.contentType;
}

export interface MetricProjection {
    name: string;
    help: string;
    type: string;
    values: Array<{ labels: Record<string, string | number>; value: number }>;
}

/**
 * The JSON rendering wi-admin's dashboard consumes.
 *
 * Explicitly reshaped rather than passing `getMetricsAsJSON()` straight through. prom-client's
 * own shape is an internal detail of a dependency; pinning it here means adding or renaming an
 * instrument stays a one-repo change instead of a two-repo dashboard break.
 */
export async function metricsProjection(): Promise<{
    collectedAt: string;
    registrySize: number;
    metrics: MetricProjection[];
}> {
    const raw = await registry.getMetricsAsJSON();
    const metrics: MetricProjection[] = raw.map((metric) => ({
        name: metric.name,
        help: metric.help,
        type: String(metric.type),
        values: ((metric as { values?: Array<{ labels?: Record<string, string | number>; value: number }> }).values ?? [])
            .map((v) => ({ labels: v.labels ?? {}, value: v.value })),
    }));

    return {
        collectedAt: new Date().toISOString(),
        registrySize: metrics.length,
        metrics,
    };
}
