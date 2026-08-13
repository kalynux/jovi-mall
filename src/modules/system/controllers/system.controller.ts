import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { describeWorkers } from '../../dev-tools/worker-registry';
import { effectiveMode } from '../domain/maintenance-mode';
import { metricsProjection } from '../metrics/metrics';
import { describeCache } from '../services/cache-inspect.service';
import {
    probeMongo,
    probeMongoServerDetail,
    probeRedis,
} from '../services/dependency-probe.service';
import {
    calendarConnectionSummary,
    describeIntegrations,
} from '../services/integration-inventory.service';
import { currentMaintenance } from '../services/maintenance.service';
import { describeQueues } from '../services/queue-depth.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { SYSTEM_CONFIG } from '../config/system.config';
import { configWiring, exposedConfig } from '../domain/exposed-config';
import { resolveInspectPlan } from '../domain/cache-flush-policy';
import { queryLogs } from '../services/log-query.service';
import { inspectCacheKeys } from '../services/cache-keys.service';
import { inspectDatabase } from '../services/database-inspect.service';
import {
    CacheKeysQuerySchema,
    DatabaseInspectQuerySchema,
    IntegrationQuerySchema,
    LogQuerySchema,
    ErrorQuerySchema,
} from '../validators/system.validator';

/**
 * `/api/internal/admin/system` — read-only operational diagnostics.
 *
 * ── Every route here is a GET, and that is the design, not a coincidence ──────
 * The brief this phase answers asks for read-only diagnostics to be separated from dangerous
 * operations. The separation is a mount, not a convention: everything that re-runs a side
 * effect against live data lives on `/api/internal/admin/dev-tools` behind a `destructive`
 * tier-1 permission and an audit row. Nothing on this router changes anything, so nothing here
 * is audited — the ordinary rule for reads.
 *
 * ── Why these are DELEGATED reads rather than wi-admin reading Mongo ──────────
 * ADR-009 D-1: delegate a verdict, read a record. Every answer here is a verdict about *this
 * process* — in-memory worker state, the live connection topology, a private metrics registry,
 * the effective maintenance mode after expiry. None of it is in a collection wi-admin could
 * read, and none of it would be true if reproduced from one.
 *
 * `/queues` is the deliberate exception worth knowing about: wi-admin ALSO reads
 * `tracking_outbox` directly, and that redundancy is a feature — during a jovi-mall incident,
 * which is exactly when an operator wants queue depth, the delegated read is the one that fails.
 */
export class SystemController {
    /**
     * GET /dependencies — Mongo and Redis, as this process actually sees them.
     *
     * Both probes run under `Promise.allSettled`, so a hung dependency degrades its own row
     * rather than hanging the response. **Nothing here opens a Redis connection** — a database
     * this process has not needed reports `idle`, which is the truthful answer and not `down`.
     */
    static dependencies = asyncHandler(async (_req: Request, res: Response) => {
        const [mongo, mongoDetail, redis] = await Promise.all([
            probeMongo(),
            probeMongoServerDetail(),
            probeRedis(),
        ]);

        const maintenance = currentMaintenance();
        const now = new Date();

        sendSuccess(res, {
            mongo: { ...mongo, server: mongoDetail },
            redis: {
                entries: redis,
                note: 'Connections are lazy — "idle" means this process has not needed that database, not that it is down.',
            },
            // Included here as well as on `/maintenance` so one dashboard call answers "is
            // anything wrong" without a second round trip.
            maintenance: {
                storedMode: maintenance.mode,
                effectiveMode: effectiveMode(maintenance, now),
                reason: maintenance.reason,
                expiresAt: maintenance.expiresAt?.toISOString() ?? null,
            },
        });
    });

    /**
     * GET /integrations — configured vs reachable, never conflated.
     *
     * `?probe=smtp,telegram` runs the on-demand probes. Everything else reports either a free
     * health path or what real traffic last learned. The per-provider policy, and the argument
     * for each `never`, is in `domain/integration-catalog.ts`.
     */
    static integrations = asyncHandler(async (req: Request, res: Response) => {
        const { probe } = IntegrationQuerySchema.parse(req.query);

        const [integrations, calendar] = await Promise.all([
            describeIntegrations({ probe: probe as never }),
            calendarConnectionSummary(),
        ]);

        sendSuccess(res, {
            integrations,
            googleCalendar: calendar,
            rule:
                'A diagnostics read never causes a side effect a customer would see, costs money, '
                + 'or consumes a quota a real request needs. Providers with reachability "never" '
                + 'have no probe that satisfies that rule.',
        });
    });

    /** GET /queues — the tracking outbox and the assignment backlog. */
    static queues = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await describeQueues());
    });

    /**
     * GET /cache — Redis key counts per database, plus instance-wide memory and hit rate.
     *
     * The two scopes are separated on the wire because Redis does not report hits and misses
     * per logical database, and presenting an instance figure as a per-database one would send
     * an operator hunting a caching bug that does not exist.
     */
    static cache = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await describeCache());
    });

    /**
     * GET /workers — all twelve, with three distinct booleans.
     *
     * `scheduled` / `executing` / `manualClaim` rather than one `running`, because three
     * different things in this codebase were called `running` and the one reported was the
     * least useful of them. See `core/jobs/worker-schedule.ts`.
     */
    static workers = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, {
            workers: describeWorkers(),
            scopeNote:
                'scheduled/executing/manualClaim are all PROCESS-LOCAL. With several instances '
                + 'behind a load balancer this describes the one that answered.',
        });
    });

    /**
     * GET /metrics — the JSON projection of the private Prometheus registry.
     *
     * Same registry as the `/metrics` text endpoint: one source of truth, two renderings. The
     * projection is explicit rather than prom-client's raw JSON, so adding or renaming an
     * instrument does not break wi-admin's dashboard shape.
     */
    static metrics = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, await metricsProjection());
    });

    /**
     * GET /maintenance — the window, if there is one.
     *
     * Reports `storedMode` and `effectiveMode` separately. They differ exactly when a window has
     * passed its `expires_at`: the document still says `down` because a read path must never
     * write, and the platform is already open. Showing only one of the two would make that
     * either invisible or inexplicable.
     */
    static maintenance = asyncHandler(async (_req: Request, res: Response) => {
        const state = currentMaintenance();
        const now = new Date();

        sendSuccess(res, {
            storedMode: state.mode,
            effectiveMode: effectiveMode(state, now),
            reason: state.reason,
            blockWebhooks: state.blockWebhooks,
            pauseWorkers: state.pauseWorkers,
            startedAt: state.startedAt?.toISOString() ?? null,
            expiresAt: state.expiresAt?.toISOString() ?? null,
            setBy: state.actorName
                ? { id: state.actorId, name: state.actorName, source: 'admin' }
                : null,
        });
    });

    // ═══ Phase 15 — developer tools ═══════════════════════════════════════════

    /**
     * GET /config — the runtime configuration, from a whitelist.
     *
     * ADR-014 named this as its natural follow-up and named the reason it was not free: the
     * `FORBIDDEN_CONFIG_TOKEN` discipline had to be reproduced here rather than assumed. It is,
     * in `domain/exposed-config.ts`, along with a boot assertion that refuses to start if this
     * list ever names something credential-shaped.
     *
     * `service` is on the wire because wi-admin serves its OWN config on a neighbouring route,
     * and a screenshot of either must be unambiguous about which process answered.
     */
    static config = asyncHandler(async (_req: Request, res: Response) => {
        sendSuccess(res, {
            service: 'jovi-mall',
            entries: exposedConfig(),
            wiring: configWiring(),
            note:
                'A whitelist, not a dump. Secrets, connection strings and every *_URL/*_URI are '
                + 'excluded by rule, not by omission — `wiring` carries the derived answers those '
                + 'would have given. An entry with `set: false` is using its compiled-in default; '
                + '`/system/workers` reports the schedule actually in force.',
        });
    });

    /**
     * GET /logs — recent lines, from the ring buffer or the capped collection.
     *
     * One route rather than two: an operator asks "what happened", and making them choose a
     * backing store first is making them learn the implementation. The answer names the store
     * that served it and carries that store's caveat.
     */
    static logs = asyncHandler(async (req: Request, res: Response) => {
        const query = LogQuerySchema.parse(req.query);

        const result = await queryLogs({
            level: query.level,
            since: query.since ? new Date(query.since) : undefined,
            until: query.until ? new Date(query.until) : undefined,
            requestId: query.requestId,
            q: query.q,
            source: query.source ?? 'persisted',
            limit: query.limit ?? 100,
            before: query.before,
        });

        sendSuccess(res, result);
    });

    /**
     * GET /errors — the error journal (Phase 16).
     *
     * A sibling of `/logs`, not a replacement: `/logs` answers "what happened during this
     * request", `/errors` answers "what failed, of what kind". Both read the same capped
     * collection through the same service, so there is one store, one cursor convention and
     * one sink-state caveat.
     *
     * ── This returns the FULL record, unprojected ────────────────────────────
     * Internal message, unfiltered `details`, cause chain and all. That is deliberate and
     * it is the existing trust model: this route sits behind `requireAdminCaller`, whose
     * token is a full-privilege credential, and jovi-mall re-checks nothing an administrator
     * was already authorized for in wi-admin.
     *
     * The developer/admin/support LADDER is applied in wi-admin, at
     * `GET /api/v1/system/errors`, because wi-admin is the only service that knows an
     * administrator's tier — `X-Actor-Tier` reaches this service but is advisory and is
     * never read for a decision (see `admin-caller.middleware.ts`). Projecting on a header
     * a caller can set, authenticated by a token that already grants everything, would be
     * theatre.
     */
    static errors = asyncHandler(async (req: Request, res: Response) => {
        const query = ErrorQuerySchema.parse(req.query);

        const result = await queryLogs({
            since: query.since ? new Date(query.since) : undefined,
            until: query.until ? new Date(query.until) : undefined,
            requestId: query.requestId,
            category: query.category,
            code: query.code,
            errorsOnly: true,
            // warn+ is what the sink persists, and every error the handler emits is warn or
            // error — so no level filter is needed or wanted here.
            source: query.source ?? 'persisted',
            limit: query.limit ?? 100,
            before: query.before,
        });

        sendSuccess(res, result);
    });

    /**
     * GET /cache/keys — key NAMES, types and TTLs in one named database.
     *
     * Values are never read, and there is deliberately no single-key value endpoint. See
     * `services/cache-keys.service.ts` for why that would be a disclosure oracle for exactly the
     * three databases the flush policy calls destructive.
     */
    static cacheKeys = asyncHandler(async (req: Request, res: Response) => {
        const query = CacheKeysQuerySchema.parse(req.query);

        const plan = resolveInspectPlan(
            { db: query.db, prefix: query.prefix, limit: query.limit },
            SYSTEM_CONFIG.CACHE_INSPECT_MAX_KEYS,
        );

        if (!plan.ok) {
            throw createAppError(
                plan.code === 'unknown_db'
                    ? ERROR_CODES.DEV_TOOLS_CACHE_DB_UNKNOWN
                    : ERROR_CODES.DEV_TOOLS_CACHE_FLUSH_REFUSED,
                plan.code === 'unknown_db' ? 404 : 422,
                plan.message,
            );
        }

        sendSuccess(res, await inspectCacheKeys(plan, query.withSize === 'true'));
    });

    /**
     * GET /database — collection stats and index drift.
     *
     * The drift half is the one that earns the endpoint: `autoIndex` is on and a failed index
     * build fails SILENTLY at boot, so a declared index can be absent for months while the
     * invariant it was protecting quietly does not hold. `missing` is the actionable bucket.
     *
     * Nothing here writes — see the service header for why a "repair" button is a different
     * decision with a maintenance window attached.
     */
    static database = asyncHandler(async (req: Request, res: Response) => {
        const query = DatabaseInspectQuerySchema.parse(req.query);
        sendSuccess(res, await inspectDatabase(query.collection));
    });
}
