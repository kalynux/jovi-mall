import { Router, RequestHandler } from 'express';
import { SystemController } from './controllers/system.controller';

/**
 * `/api/internal/admin/system` — the read-only operations surface wi-admin renders.
 *
 * ── Every route is a GET, and the split is a MOUNT rather than a convention ───
 * Dangerous operations live next door on `/api/internal/admin/dev-tools`: triggering a worker,
 * replaying the outbox, rebuilding search vectors, opening a maintenance window, flushing a
 * cache database. Each of those re-runs a side effect against live data, and each is behind a
 * `destructive` tier-1 permission and an audit row on the wi-admin side.
 *
 * Nothing here changes anything, so nothing here is audited — the ordinary rule for reads. Keep
 * it that way: a mutation added to this router would silently inherit the read surface's
 * permissions and skip the audit trail entirely.
 *
 * ── Why these are asked for rather than read out of the database ──────────────
 * ADR-009 D-1 — delegate a verdict, read a record. Every answer here is a verdict about *this
 * process*: which cron tasks exist and whether one is mid-sweep, which Redis connections are
 * open right now, what a private in-memory metrics registry holds, which maintenance mode is
 * in force after expiry is applied. None of it lives in a collection, and a copy of the logic
 * in wi-admin would be a second opinion about this process's own state.
 *
 * ── Guarded ONLY by the service token ─────────────────────────────────────────
 * Like every other route on this mount. Authorization is resolved in wi-admin before the call
 * arrives, which is exactly what makes the service token a full-privilege credential. Nothing
 * here may become reachable from `/api/admin/*` — these are not dashboard endpoints.
 */
export function buildAdminSystemRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);

    router.get('/dependencies', SystemController.dependencies);
    router.get('/integrations', SystemController.integrations);
    router.get('/queues', SystemController.queues);
    router.get('/cache', SystemController.cache);
    router.get('/workers', SystemController.workers);
    router.get('/metrics', SystemController.metrics);
    router.get('/maintenance', SystemController.maintenance);

    // ── Phase 15 ─────────────────────────────────────────────────────────────
    //
    // `/cache/keys` is declared AFTER `/cache`, and they do not collide because they are at
    // different depths — but a `/cache/:something` sibling added later WOULD shadow it. Same
    // hazard `dev-tools.routes.ts` calls out for `/workers` vs `/workers/:workerKey/run`.
    router.get('/config', SystemController.config);
    router.get('/logs', SystemController.logs);
    router.get('/errors', SystemController.errors);
    router.get('/cache/keys', SystemController.cacheKeys);
    router.get('/database', SystemController.database);

    return router;
}
