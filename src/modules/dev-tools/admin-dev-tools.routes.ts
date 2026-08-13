import { Router, RequestHandler, Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { adminCallerActor } from '../../api/middlewares/admin-caller.middleware';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { TrackingOutboxModel } from '../tracking-integration/models/tracking-outbox.model';
import { VendorProductController } from '../catalog/controllers/vendor-product.controller';
import { SYSTEM_CONFIG } from '../system/config/system.config';
import { recordWorkerRun } from '../system/metrics/metrics';
import { resolveFlushPlan } from '../system/domain/cache-flush-policy';
import { resolvePrunePlan } from '../system/domain/outbox-prune-policy';
import { executeFlush } from '../system/services/cache-flush.service';
import { setMaintenance } from '../system/services/maintenance.service';
import { FlushCacheSchema, SetMaintenanceSchema } from '../system/validators/system.validator';
import {
    WORKER_KEYS,
    WORKER_REGISTRY,
    describeWorkers,
    isWorkerKey,
    releaseWorker,
    tryClaimWorker,
} from './worker-registry';

/**
 * `/api/internal/admin/dev-tools` — the operational tools wi-admin drives.
 *
 * ── Why these live here and not in wi-admin ───────────────────────────────────
 * The same rule every other delegated write follows: the workers, the tracking outbox and
 * the catalogue all live in THIS process, and the invariants they touch are enforced by
 * code that runs here. wi-admin holds the permission and the audit row; jovi-mall does the
 * work. See `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md` D-2.
 *
 * ── Guarded ONLY by the service token ─────────────────────────────────────────
 * Like every other route on this mount. `developer_tools.*` is tier-1-only, and that
 * decision is made in wi-admin before the call arrives — this side re-checks nothing, which
 * is exactly what makes the service token a full-privilege credential. Nothing here may
 * become reachable from `/api/admin/*`: these are not dashboard endpoints.
 *
 * There is deliberately no `webhooks/redeliver`. Every `/webhooks/*` mount in this service
 * is INBOUND (payments, WhatsApp, Telegram) and nothing records an outbound delivery, so
 * there is nothing to redeliver. The only outbound mechanism is the tracking outbox, which
 * `outbox/replay` below covers.
 */
export function buildAdminDevToolsRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);

    /**
     * GET /workers — what exists, what it is for, and what is running now.
     *
     * A verdict rather than a record (ADR-009 D-1): worker state is in-memory cron in this
     * process, not a collection wi-admin could read.
     *
     * ── This shape is FROZEN, and the richer surface lives elsewhere ───────────
     * `GET /api/internal/admin/system/workers` is the full observation — all twelve workers,
     * three distinct booleans, structured schedules, `enabled`, `pausedByMaintenance`. This
     * endpoint keeps its byte-shape because **two** wi-admin call sites read it
     * (`SystemController.workers` and `DevToolsController.listWorkers`, both through
     * `devTools.listWorkers()`), and jovi-mall deploys first — changing the shape here would
     * open a window where wi-admin's own `/api/v1/system/workers` breaks.
     *
     * Two fields got strictly more truthful at an unchanged shape, which needs no coordination:
     *   `schedule`  now DERIVED from what the worker actually schedules with. It was hand-typed
     *               and wrong for eight of ten entries.
     *   `running`   now `executing || manualClaim` rather than manual claims alone, so a
     *               scheduled sweep in flight no longer reports false.
     *
     * Deprecating this in favour of `/system/workers` is a follow-up, once wi-admin is
     * re-pointed. Named here so it does not get lost.
     */
    router.get('/workers', asyncHandler(async (_req: Request, res: Response) => {
        const reports = describeWorkers();

        res.json({
            success: true,
            data: {
                workers: WORKER_KEYS.map((key) => {
                    const report = reports.find((r) => r.key === key)!;
                    return {
                        key,
                        label: WORKER_REGISTRY[key].label,
                        schedule: report.scheduleLabel,
                        running: report.executing || report.manualClaim,
                    };
                }),
                // Stated on the wire, not just in a comment: a dashboard showing `running`
                // must not imply it is authoritative across instances.
                runningIsProcessLocal: true,
            },
        });
    }));

    /**
     * POST /workers/:workerKey/run — one pass, now, against live data.
     *
     * Awaited rather than fired and forgotten, so the response reports what happened. Some
     * of these sweeps are slow; that is the caller's problem to time out on, and a
     * fire-and-forget 202 would give an administrator no way to know whether it worked.
     */
    router.post('/workers/:workerKey/run', asyncHandler(async (req: Request, res: Response) => {
        const { workerKey } = req.params;

        if (!isWorkerKey(workerKey)) {
            throw createAppError(
                ERROR_CODES.DEV_TOOLS_WORKER_UNKNOWN,
                404,
                `No worker named "${workerKey}"`,
                { known: WORKER_KEYS },
            );
        }

        if (!tryClaimWorker(workerKey)) {
            throw createAppError(
                ERROR_CODES.DEV_TOOLS_WORKER_BUSY,
                409,
                `"${workerKey}" is already running`,
            );
        }

        const startedAt = Date.now();
        try {
            const result = await WORKER_REGISTRY[workerKey].runOnce();
            /**
             * Phase 15: the worker metrics were declared in Phase 14 and incremented by NOTHING,
             * so `jovimall_worker_last_success_timestamp_seconds` — described in `metrics.ts` as
             * "the single most useful worker signal" — was permanently empty and the documented
             * `time() - last_success > 86400` alert could never fire. This site already had
             * `startedAt` and a `try/finally`, so instrumenting it costs two lines.
             */
            recordWorkerRun(
                workerKey, 'manual', 'success', (Date.now() - startedAt) / 1000, result.processed,
            );
            res.json({
                success: true,
                data: { worker: workerKey, durationMs: Date.now() - startedAt, ...result },
            });
        } catch (error) {
            recordWorkerRun(workerKey, 'manual', 'failure', (Date.now() - startedAt) / 1000);
            throw error;
        } finally {
            // `finally`, so a throwing sweep does not leave the worker permanently claimed
            // and unrunnable until the process restarts.
            releaseWorker(workerKey);
        }
    }));

    /**
     * POST /outbox/replay — put failed tracking events back in the queue.
     *
     * ── What "replay" means, precisely ────────────────────────────────────────
     * Only `failed` rows are eligible, and they are reset to `pending` for the dispatcher to
     * pick up on its next drain. Replaying a `sent` row would deliver a lifecycle event to
     * geo-tracker a second time — it dedups on `eventId`, so it would be absorbed, but
     * relying on the far side's dedup to make a local mistake harmless is not a design.
     *
     * Bounded by `limit` (default 100, max 1000): a replay of everything that ever failed is
     * rarely what is meant, and an unbounded one would flood the dispatcher.
     */
    router.post('/outbox/replay', asyncHandler(async (req: Request, res: Response) => {
        const rawLimit = Number(req.body?.limit ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;
        const ids: unknown = req.body?.eventIds;

        const filter: Record<string, unknown> = { status: 'failed' };
        if (Array.isArray(ids) && ids.length > 0) {
            filter._id = { $in: ids };
        }

        const candidates = await TrackingOutboxModel.find(filter).select('_id').limit(limit).lean();

        if (candidates.length === 0) {
            res.json({ success: true, data: { replayed: 0, note: 'No failed rows matched' } });
            return;
        }

        const result = await TrackingOutboxModel.updateMany(
            { _id: { $in: candidates.map((row) => row._id) } },
            // `attempts` is reset so the dispatcher's backoff starts fresh — a row replayed
            // deliberately should not be immediately re-failed by an exhausted counter.
            { $set: { status: 'pending', attempts: 0, last_error: null } },
        );

        res.json({
            success: true,
            data: { replayed: result.modifiedCount ?? 0, requested: candidates.length },
        });
    }));

    /**
     * POST /outbox/prune — delete DELIVERED rows past a retention age. **Phase 15.**
     *
     * ADR-014 recorded "`sent` rows are never pruned" as a debt, and it is a compounding one:
     * the collection's only index is `{status, created_at}`, so every scan over it — including
     * the dispatcher's own drain every two seconds — gets slower with age, forever.
     *
     * The guards mirror `cache/flush` because the shape of the risk is the same: `dryRun`
     * defaults TRUE, `confirm` must be repeated, and the whole thing is bounded. What differs
     * is what `confirm` repeats — see `domain/outbox-prune-policy.ts`, where every refusal
     * lives as a pure function.
     *
     * The delete is find-then-`deleteMany({_id: {$in}})`, never an unbounded
     * `deleteMany({created_at: {$lt}})`. A single unbounded delete over millions of rows on a
     * primary is an availability event, and `truncated` tells the operator to run it again
     * rather than leaving them to guess.
     */
    router.post('/outbox/prune', asyncHandler(async (req: Request, res: Response) => {
        const plan = resolvePrunePlan(
            {
                olderThanDays: Number(req.body?.olderThanDays),
                status: String(req.body?.status ?? ''),
                limit: req.body?.limit === undefined ? undefined : Number(req.body.limit),
                dryRun: req.body?.dryRun,
                confirm: String(req.body?.confirm ?? ''),
            },
            new Date(),
        );

        if (!plan.ok) {
            throw createAppError(ERROR_CODES.DEV_TOOLS_OUTBOX_PRUNE_REFUSED, 422, plan.message, {
                code: plan.code,
            });
        }

        const filter = { status: 'sent', created_at: { $lt: plan.cutoff } };

        const candidates = await TrackingOutboxModel.find(filter)
            .select('_id')
            .sort({ created_at: 1 })
            .limit(plan.limit)
            .lean();

        const deleted = plan.dryRun || candidates.length === 0
            ? 0
            : (await TrackingOutboxModel.deleteMany({ _id: { $in: candidates.map((row) => row._id) } }))
                .deletedCount ?? 0;

        // The oldest row still there afterwards is how an operator knows whether one more pass
        // is worth running, without re-deriving the cutoff themselves.
        const oldestRemaining = await TrackingOutboxModel.find({ status: 'sent' })
            .select('created_at')
            .sort({ created_at: 1 })
            .limit(1)
            .lean();

        res.json({
            success: true,
            data: {
                status: 'sent',
                olderThanDays: plan.olderThanDays,
                cutoff: plan.cutoff.toISOString(),
                dryRun: plan.dryRun,
                matched: candidates.length,
                deleted,
                truncated: candidates.length === plan.limit,
                oldestRemainingSentAt:
                    (oldestRemaining[0] as { created_at?: Date } | undefined)?.created_at?.toISOString() ?? null,
            },
        });
    }));

    /**
     * POST /catalogue/vectorise — rebuild search vectors across every product.
     *
     * The one legacy developer tool that already existed, at
     * `POST /api/admin/products/bulk-vectorise`. Same controller, so there is one
     * implementation rather than a copy that drifts; the legacy mount stays live until
     * cutover, and its row leaves `LEGACY_ENDPOINT_MAP`.
     */
    router.post('/catalogue/vectorise', VendorProductController.bulkVectorise);

    /**
     * PUT /maintenance — open or close a maintenance window.
     *
     * ── Why this is the most dangerous verb on this router ────────────────────
     * Everything else here re-runs a side effect. This one **refuses traffic** — in `down`, all
     * of it. It is also the only operation whose own failure mode is losing the ability to undo
     * it, which is why three things are true and none of them is optional:
     *
     *  1. `/api/internal/admin/*` is exempt from the window — the WHOLE prefix, so an operator
     *     can both read `/system/*` to decide and call this to exit. See
     *     `modules/system/domain/maintenance-mode.ts`.
     *  2. `expiresInMinutes` is bounded at 24h and strongly encouraged. A window nobody
     *     remembers to close is the common failure, not a window closed too early.
     *  3. On the wi-admin side this one tool **bypasses the `dev_tools.enabled` feature flag**,
     *     unlike every other tool there. Otherwise an operator could not enter maintenance
     *     during an incident without first turning that flag on — and worse, somebody turning
     *     it off mid-window would lock the exit. Same carve-out, same reasoning, as the
     *     feature-flag routes themselves: a switch must not be able to turn off its own switch.
     *
     * Idempotent: re-issuing the current mode returns `changed: false` and does not restart the
     * window's clock.
     */
    router.put('/maintenance', asyncHandler(async (req: Request, res: Response) => {
        const input = SetMaintenanceSchema.parse(req.body ?? {});
        const actor = adminCallerActor(req);

        const result = await setMaintenance({
            mode: input.mode,
            reason: input.reason ?? null,
            expiresAt: input.expiresInMinutes
                ? new Date(Date.now() + input.expiresInMinutes * 60_000)
                : null,
            blockWebhooks: input.blockWebhooks ?? false,
            // Defaults to pausing only in `down`. A `readonly` window usually means a schema
            // change on one collection, and the sweeps are the platform's correctness
            // machinery — pausing `tracking-dispatch` leaves geo-tracker broadcasting a
            // delivered shipment's position, and pausing `unpaid-booking-cancel` holds slots
            // for free. Pausing them there is worse than letting them run.
            pauseWorkers: input.pauseWorkers ?? input.mode === 'down',
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? null,
        });

        res.json({
            success: true,
            data: {
                changed: result.changed,
                previousMode: result.previousMode,
                mode: result.state.mode,
                reason: result.state.reason,
                blockWebhooks: result.state.blockWebhooks,
                pauseWorkers: result.state.pauseWorkers,
                startedAt: result.state.startedAt?.toISOString() ?? null,
                expiresAt: result.state.expiresAt?.toISOString() ?? null,
                // Stated rather than discovered. Other instances read the singleton through a
                // short cache, so there is a real window in which they disagree — an operator
                // watching one instance flip should know how long to wait for the rest.
                convergenceSeconds: result.convergenceSeconds,
            },
            message: result.changed
                ? `Maintenance mode is now "${result.state.mode}". Other instances converge within ${result.convergenceSeconds}s.`
                : `Maintenance mode was already "${result.state.mode}".`,
        });
    }));

    /**
     * POST /cache/flush — delete cached keys from ONE named logical database.
     *
     * Dry run by default (mirroring `FILE_CLEANUP_DRY_RUN`), `confirm` must repeat the database
     * name, databases are addressed by NAME rather than index, SCAN rather than KEYS, bounded by
     * both a key limit and a wall-clock budget, and truncation is reported rather than swallowed.
     * There is no whole-instance flush and `FLUSHALL` appears nowhere in the path.
     *
     * The per-database blast radius — including why clearing `SLOT_LOCK_DB` is degraded rather
     * than broken, and why `WA_IDEMPOTENCY_DB` can cost a customer a duplicate message — is in
     * `modules/system/domain/cache-flush-policy.ts` and travels back in the response so it lands
     * in wi-admin's audit row.
     */
    router.post('/cache/flush', asyncHandler(async (req: Request, res: Response) => {
        const input = FlushCacheSchema.parse(req.body ?? {});

        const plan = resolveFlushPlan(input, SYSTEM_CONFIG.CACHE_FLUSH_MAX_KEYS);
        if (!plan.ok) {
            throw createAppError(
                plan.code === 'unknown_db'
                    ? ERROR_CODES.DEV_TOOLS_CACHE_DB_UNKNOWN
                    : ERROR_CODES.DEV_TOOLS_CACHE_FLUSH_REFUSED,
                plan.code === 'unknown_db' ? 404 : 422,
                plan.message,
                { code: plan.code },
            );
        }

        try {
            res.json({ success: true, data: await executeFlush(plan) });
        } catch (error) {
            throw createAppError(
                ERROR_CODES.DEV_TOOLS_CACHE_UNAVAILABLE,
                503,
                error instanceof Error ? error.message : 'The cache is not reachable from this process',
                { db: plan.constant },
            );
        }
    }));

    return router;
}
