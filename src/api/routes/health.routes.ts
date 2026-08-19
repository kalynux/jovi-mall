import { Request, Response, Router } from 'express';
import { asyncHandler } from '../middlewares/async-handler';
import { probeMongo, probeRedis } from '../../modules/system/services/dependency-probe.service';
import { currentMaintenance } from '../../modules/system/services/maintenance.service';
import { effectiveMode } from '../../modules/system/domain/maintenance-mode';
import { SYSTEM_CONFIG } from '../../modules/system/config/system.config';

/**
 * The probe surface. Unauthenticated, and mounted before the maintenance middleware.
 *
 * ═══ `GET /api/health` IS FROZEN ══════════════════════════════════════════════
 *
 * Exact path, exact body (`{status, timestamp}`), unconditional 200. Do not "improve" it into a
 * readiness check. Two services depend on it and one of them turns a jovi-mall wobble into its
 * own outage:
 *
 *  1. `geo-tracker/internal/modules/health/checker/node_checker.go` — hits this path via
 *     `NODE_API_HEALTH_PATH` and is registered as a **readiness** checker on geo-tracker's
 *     `/readyz`. Its client (`internal/platform/nodeclient/client.go`) treats ANY status ≥ 300
 *     as an error and never parses the body, so only the status code is load-bearing.
 *
 *     The cascade, if readiness moved onto this path: jovi-mall's Redis wobbles → this 503s →
 *     geo-tracker's `/readyz` 503s → the orchestrator pulls geo-tracker out of rotation →
 *     **every live WebSocket tracking session dies**, for a fault entirely inside a different
 *     service that is itself perfectly healthy. A coupled-failure amplifier, from a one-line
 *     change that would look like a tidy-up in review.
 *
 *  2. `admin/src/infra/platform/platform.client.ts` — `pingPlatform()` GETs this and surfaces
 *     the result on wi-admin's `/health/ready` and `/api/v1/system/health`. Less severe, but a
 *     second contract on the same path.
 *
 * `npm run test:system` asserts the registered path, the unconditional 200, the exact key set
 * `{status, timestamp}` and the absence of the house `{success, data}` envelope — by invoking
 * this handler off the router's own layer stack, so a future edit fails the suite rather than
 * the fleet. `npm run test:errors` asserts the rate-limit exemption on the same path.
 *
 * ⚠ Until plan step 2.B.6 that sentence was a LIE: this comment claimed the assertions existed
 * and what `test:system` actually covered was the MAINTENANCE exemption, a different property.
 * The claim is what stopped anyone writing the test. Both assertions were negative-tested when
 * they landed — adding a body key and returning 503 each fail the suite.
 *
 * ═══ The other two ════════════════════════════════════════════════════════════
 *
 * `/live` is for "should this process be restarted", and touches nothing — restarting does not
 * fix somebody else's database, so a dependency has no business failing a liveness probe.
 * `/ready` is for "should this instance receive traffic", and is where dependencies belong.
 */
const router = Router();

/**
 * GET /api/health — FROZEN. See the header before changing anything here.
 *
 * Not wrapped in `sendSuccess`: this shape is a wire contract with two other services, not a
 * house-style response.
 */
router.get('/', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** GET /api/health/live — process-only liveness. */
router.get('/live', (_req: Request, res: Response) => {
    res.json({
        status: 'alive',
        service: 'jovi-mall',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /api/health/ready — the real readiness probe.
 *
 * ── Mongo is required; Redis is not ───────────────────────────────────────────
 * Two independent reasons, and the second is the decisive one:
 *
 *  1. Every Redis consumer in this codebase is feature-scoped and already degrades — email
 *     verification tokens, WhatsApp codes and idempotency keys, booking slot holds, download
 *     tokens, Telegram links. With Redis down this process still serves the catalogue, orders,
 *     payments and shipments. Failing readiness would pull the whole instance out of rotation
 *     for a partial capability loss.
 *
 *  2. **Redis connects lazily and never at boot.** A required-Redis probe would *provision* a
 *     connection this process never made, on DB 0 — an index nothing in this codebase uses — on
 *     every probe interval. A diagnostics probe that changes the connection topology it claims
 *     to measure is a probe that lies. See `infra/redis/redis.factory.ts`.
 *
 * So Redis reports three honest states and contributes `degraded`, never a 503: `open` (pinged),
 * `idle` (no client open in this process — which is a truthful statement, not a failure), and
 * `down` (an open client failed its ping). `HEALTH_READY_REQUIRE_REDIS=true` is there for an
 * operator who wants hard coupling.
 *
 * ── geo-tracker is deliberately NOT a dependency here ─────────────────────────
 * Its readiness already depends on this service. Making the reverse true creates a mutual
 * readiness deadlock in which a cold start of both never converges. It appears on
 * `/system/integrations` as reachability, and nowhere on a probe.
 *
 * ── 200 during maintenance, always ────────────────────────────────────────────
 * If readiness failed inside a maintenance window, the orchestrator would restart the fleet and
 * the window would become an outage nobody can exit. The mode is reported in the body instead.
 * Draining traffic is a load-balancer action, not a maintenance-mode side effect.
 */
router.get('/ready', asyncHandler(async (_req: Request, res: Response) => {
    const [mongo, redis] = await Promise.all([probeMongo(), probeRedis()]);

    const redisRequired = SYSTEM_CONFIG.HEALTH_READY_REQUIRE_REDIS;
    const redisDown = redis.some((entry) => entry.status === 'down');
    const ready = mongo.status === 'up' && (!redisRequired || !redisDown);

    const maintenance = currentMaintenance();
    const mode = effectiveMode(maintenance, new Date());

    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        service: 'jovi-mall',
        degraded: redisDown && !redisRequired,
        maintenance: mode === 'off' ? null : mode,
        dependencies: {
            mongo: { ...mongo, required: true },
            redis: { entries: redis, required: redisRequired },
        },
        timestamp: new Date().toISOString(),
    });
}));

export const healthRoutes = router;
