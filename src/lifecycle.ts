import type { Server } from 'http';
import mongoose from 'mongoose';
import { app } from './app';
import { initLogging, enableLogPersistence, logger, logMongoSink } from './core/logging';
import { assertSigningSecrets } from './config/secrets.config';
import { assertEnvironment } from './config/env';
import { assertInternalAdminToken } from './config/internal-admin.config';
import { assertExposedConfigSafe } from './modules/system/domain/exposed-config';
import { assertUploadScannerSafe } from './core/uploads/scanners';
import { loadUploadConfig } from './core/uploads/upload-config';
import { reportBotWebhookGuard } from './api/middlewares/bot-webhook.middleware';
import { initAggregationScheduler } from './core/jobs/aggregation-scheduler';
import { awaitWorkerLocksReleased, locksHeldInProcess } from './core/jobs/worker-lock';
import { stopAllWorkers } from './modules/dev-tools/worker-registry';
import { initializeMetrics, installOutboxDepthProvider, recordMongoError } from './modules/system/metrics/metrics';
import { outboxDepthForMetrics } from './modules/system/services/queue-depth.service';
import { primeMaintenanceState } from './modules/system/services/maintenance.service';
import { inspectDatabase } from './modules/system/services/database-inspect.service';
import { SYSTEM_CONFIG } from './modules/system/config/system.config';
import { closeRedisClients } from './infra/redis/redis.factory';
import { planExpiryWorker } from './modules/billing/workers/plan-expiry.worker';
import { agencyShipmentCapWorker } from './modules/billing/workers/agency-shipment-cap.worker';
import { registerAgentPlanCapacityConsumer } from './modules/agents/events/agent-plan-capacity.consumer';
import { initializeVendorNotificationEventConsumers } from './modules/notifications/vendor-notification-event-consumer';
import { initializeAgencyNotificationEventConsumers } from './modules/notifications/agency-notification-event-consumer';
import { initializeAgentNotificationEventConsumers } from './modules/notifications/agent-notification-event-consumer';
import { initializeCustomerNotificationEventConsumers } from './modules/notifications/customer-notification-event-consumer';
import { fileCleanupWorker } from './modules/file-cleanup/workers/file-cleanup.worker';
import { earningsReleaseWorker } from './modules/earnings/workers/earnings-release.worker';
import { unpaidOrderCancelWorker } from './modules/orders/workers/unpaid-order-cancel.worker';
import { unpaidBookingCancelWorker } from './modules/booking/workers/unpaid-booking-cancel.worker';
import { bookingReminderWorker } from './modules/booking/workers/booking-reminder.worker';
import { inboundCalendarSyncWorker } from './modules/booking/workers/inbound-calendar-sync.worker';
import { codDepositDeadlineWorker } from './modules/cod/workers/cod-deposit-deadline.worker';
import { paymentReconciliationWorker } from './modules/payments/workers/payment-reconciliation.worker';
import { trackingDispatchWorker } from './modules/tracking-integration/workers/tracking-dispatch.worker';
import { initializeAgentDomain } from './modules/agents';
import { initializeShipmentAssignment } from './modules/shipment-assignment';
import { agentCapacityReconcileWorker } from './modules/agents/workers/agent-capacity-reconcile.worker';
import { agentTrustRecomputeWorker } from './modules/agents/workers/agent-trust-recompute.worker';
import { trackingAllowReconcileWorker } from './modules/agents/workers/tracking-allow-reconcile.worker';
import { initRateLimiters } from './api/rate-limit/rate-limit.middleware';

/**
 * Service lifecycle: start-up and drain.
 *
 * ── Why this is not in `server.ts` ────────────────────────────────────────────
 * `server.ts` is now a three-line entrypoint, and the split is the same one
 * `admin/src/lifecycle.ts` makes, for the same reason: **Windows cannot deliver a real
 * `SIGTERM` to a child process.** Node maps `child.kill('SIGTERM')` onto `TerminateProcess`,
 * an uncatchable hard kill — so a shutdown reachable only through a signal handler is
 * untestable on the development platform and would first be exercised in production, on the
 * one path where getting it wrong truncates a payment.
 *
 * `drain()` is exported and callable directly. That is what makes it assertable.
 *
 * ── What this replaces ────────────────────────────────────────────────────────
 * `app.listen(PORT, cb)` with the handle discarded, no signal handling, no
 * `unhandledRejection`, no `uncaughtException`, and no stop call for any of the fourteen
 * background workers — two of whose sweeps move money (`EarningsReleaseWorker`,
 * `CodDepositDeadlineWorker`) and a third of which settles payments
 * (`PaymentReconciliationWorker`). A hard kill also left a `withWorkerLock` Redis lock held
 * until its `PX` expiry, so the replacement instance's sweep was refused for that window.
 *
 * Two partial handlers existed and were folded in here rather than left beside this:
 * `core/logging/index.ts` flushed the Mongo log sink on `SIGTERM`, and
 * `inbound-calendar-sync.worker.ts` stopped itself. Both ran CONCURRENTLY with any real
 * drain — the first landing a flush on a connection the drain is closing — which is why
 * "two out of fourteen were handled" was not a partial version of this, but a race against it.
 *
 * BOOT ORDER is load-bearing: validate configuration → open Mongo → start background work →
 * only then bind the port. The service must never accept a request it cannot serve.
 *
 * See PRODUCTION-READINESS plan step 2.A; fixes 02 · C-7 and 03 · R-1.
 */

const PORT = process.env.PORT || 8022;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let httpServer: Server | null = null;
let draining = false;
let drained = false;

export async function startServer(): Promise<Server> {
    // Logging FIRST — before the assertions below, so a refused boot is itself captured
    // rather than being the one event nothing records. `dotenv/config` has already run at
    // import, so LOG_LEVEL and the rest are readable. Only the ring buffer is live at this
    // point; persistence needs Mongo and is enabled further down.
    initLogging();

    // Signing secrets, before anything else: a missing JWT_SECRET used to fall back
    // to the literal 'secret', so a misconfigured deploy booted fine and accepted
    // forged tokens. Fail here, loudly, instead of on the first request.
    assertSigningSecrets();
    // Everything else about the environment, in one pass and reporting every problem at once.
    // Runs AFTER the signing secrets so the most dangerous single variable still fails first
    // and alone, and before the rest so a deploy learns about its ignored Cloudinary block,
    // its unparseable interval and its empty CORS allowlist at boot rather than from a user.
    assertEnvironment();
    // Optional until the admin service cuts over — but a token set to a placeholder is
    // worse than none, because the API is then open and looks configured.
    assertInternalAdminToken();
    // Same posture, one step further: a config whitelist that names a credential must kill the
    // process rather than serve it once. Pure function of code, so it belongs beside the other
    // two and before anything can accept a request.
    assertExposedConfigSafe();
    // Same posture again, and for a finding that survived on exactly this gap: every upload
    // path builds its scanner PER REQUEST, so a provider that cannot scan — `cloud`, a typo,
    // or `mock` in production (which is what a deploy gets by forgetting the variable, since
    // it is the default) — would boot cleanly and be discovered by a vendor. Refuse here.
    assertUploadScannerSafe(loadUploadConfig(), (message) => console.log(message));
    // Reports rather than asserts, because the guard's unset behaviour differs by
    // environment: production refuses every bot webhook, development leaves them open.
    // Either way an operator should read it in the boot log rather than discover it —
    // `/connect` mints a credential, so "are the bot webhooks authenticated?" is now a
    // question with a security answer. See api/middlewares/bot-webhook.middleware.ts.
    reportBotWebhookGuard((message) => console.log(message));

    // Database Connection
    //
    // ── `autoIndex` OFF IN PRODUCTION (plan step 2.C.4) ───────────────────────────
    // Until now this service left Mongoose's default on, and its own CLAUDE.md recorded
    // the result: an index build triggered by a boot fails SILENTLY — the promise rejects
    // into a listener nobody attached and the process comes up healthy. For a read index
    // that is a slow page; for `payment_webhook_events`' unique `(gateway, eventId)` it is
    // webhook dedup quietly not existing. It is also an unannounced load spike on the
    // primary, timed to a deploy, which is the worst moment for one.
    //
    // wi-admin has had exactly this line since Phase 4 (`infra/mongo/connections.ts`),
    // with a comment naming this service as the counter-example. Matching it makes index
    // creation an explicit, ledgered migration step — `npm run migrate:up`.
    //
    // Turning it off converts a silent-SLOW failure into a silent-MISSING one, so it is
    // paired with `reportIndexDrift()` after the listener opens. Development keeps
    // `autoIndex` on: a developer who has just written a schema should not have to run a
    // migration to use it.
    await mongoose.connect(MONGO_URI, {
        autoIndex: process.env.NODE_ENV !== 'production',
    });
    console.log('Connected to MongoDB');

    /**
     * Connection-level Mongo error counting.
     *
     * `jovimall_mongo_operation_errors_total` was declared in Phase 14 and incremented by
     * nothing, while `api-doc/admin/system.md` claimed it covered connection errors AND query
     * errors "caught by a schema-level post-hook" — a hook that does not exist anywhere in
     * `src/`. So the counter read a permanent zero, which is worse than a counter that is
     * honestly partial. These two listeners close the connection-level half and bring it level
     * with Redis, which has had an error sink since Phase 14. The query-level half needs a
     * global Mongoose plugin registered before the first `model()` call; that is a bootstrap
     * ordering change across 182 models and is deliberately NOT done here (ADR-015, debts).
     */
    mongoose.connection.on('error', (error: Error) => {
        recordMongoError('connection');
        logger().error({ err: error }, 'Mongo connection error');
    });
    mongoose.connection.on('disconnected', () => {
        recordMongoError('disconnected');
        logger().warn('Mongo disconnected');
    });

    // Log persistence, now that there is a connection to write to. Lines produced before this
    // point live in the ring buffer only; `/system/logs` reports the sink state so that
    // boundary is visible rather than mysterious.
    await enableLogPersistence();

    // Metrics: install the private registry's hooks before anything can emit. Also the point
    // where the Redis error sink is wired, so a connection failure during boot is counted.
    initializeMetrics();
    // Outbox depth is computed ON SCRAPE rather than on a timer — this process already carries
    // fourteen of those, and a poller would run the aggregation whether or not anyone is
    // looking. Installed here so the collector cannot import the tracking module directly.
    installOutboxDepthProvider(outboxDepthForMetrics);

    // Maintenance mode, BEFORE the listener opens. An instance starting during a window must
    // come up already closed — otherwise a rolling deploy serves one full cache window of
    // writes against a platform that is supposed to be shut, which is precisely the thing the
    // window exists to prevent, at precisely the worst moment.
    const maintenance = await primeMaintenanceState();

    // Swap the rate limiters onto the shared Redis store, now that Mongo is up and the
    // process is committed to serving. Before this they use an in-memory store, which
    // still bounds a caller — just per process, so N instances multiply the ceiling by
    // N. Awaited rather than fired off, so the listener never opens on a limiter that
    // is halfway through being replaced.
    await initRateLimiters();

    if (maintenance.mode !== 'off') {
        console.warn(
            `[Maintenance] Starting INSIDE a "${maintenance.mode}" window — ${maintenance.reason ?? 'no reason recorded'}`
        );
    }

    // Agent domain: installs the device-location provider behind the
    // eligibility rules. Must run before any dispatch path evaluates an agent;
    // swapping in geo-tracker's provider later is a change HERE and nowhere else.
    initializeAgentDomain();

    startBackgroundWork();

    const server = await new Promise<Server>((resolve, reject) => {
        const instance = app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            resolve(instance);
        });
        // A bind failure (EADDRINUSE, EACCES) is emitted ASYNCHRONOUSLY on the server, not
        // thrown by `listen`. Without this listener it is an unhandled 'error' event, which
        // takes the process down with a bare stack trace instead of rejecting into the
        // caller's error handling — and during boot that is indistinguishable from a crash.
        instance.once('error', reject);
    });

    // Node's default keep-alive timeout of 0 leaves sockets open indefinitely, which holds a
    // drain open and leaks sockets across a long-lived deployment. `headersTimeout` must
    // EXCEED `keepAliveTimeout` or Node races itself and drops valid requests. Same values and
    // same reasoning as wi-admin.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    // The other half of turning `autoIndex` off. Deliberately AFTER the listener opens and
    // deliberately not awaited — see the function's own header.
    void reportIndexDrift();

    httpServer = server;
    return server;
}

/**
 * Log any declared-but-absent index, once, at boot. Plan step 2.C.4.
 *
 * ── Why this exists at all ────────────────────────────────────────────────────
 * `autoIndex` is now off in production, which is right — but it trades a silent-SLOW
 * failure for a silent-MISSING one. Before, a declared index that failed to build left a
 * slow query. Now, a declared index nobody built simply is not there, and the only
 * detectors were `verify:live-parity` (a handful of models) and
 * `GET /api/internal/admin/system/database`, both of which need somebody to go and look.
 * An operator should learn this from the boot log, not from a duplicate that got through
 * a unique constraint that was never created.
 *
 * ── It REPORTS. It does not build, and it does not fail readiness ─────────────
 * Building here would reintroduce exactly what `autoIndex` was turned off to stop. Failing
 * readiness on drift would mean a fresh database — where every index is legitimately
 * missing until the first migration runs — can never become ready, which is a deadlock at
 * precisely the moment somebody is trying to bring the system up for the first time.
 * Whether drift should gate readiness is a later phase's decision, made with a ledger to
 * consult; this is the warning that makes the question askable.
 *
 * ── Not awaited, and after the listener ───────────────────────────────────────
 * `inspectDatabase` walks the collection registry issuing two commands each, bounded by
 * `DB_INSPECT_BUDGET_MS`. That is real work on a primary, and none of it is a precondition
 * for serving a request. Awaiting it would add its whole budget to every boot and to every
 * rolling-deploy step. It can never throw: a report that takes the process down is worse
 * than no report.
 */
async function reportIndexDrift(): Promise<void> {
    try {
        const result = await inspectDatabase(null);

        const drifted = result.collections.filter((c) => c.indexes.drift.missing.length > 0);

        if (drifted.length === 0) {
            logger().info(
                { collections: result.summary.collections, declaredIndexes: result.summary.declaredIndexes },
                'index drift: none — every declared index exists'
            );
        } else {
            for (const collection of drifted) {
                logger().warn(
                    {
                        collection: collection.name,
                        missing: collection.indexes.drift.missing.map((index) => index.key),
                    },
                    'index drift: DECLARED INDEX MISSING — run `npm run migrate:up`'
                );
            }
            logger().warn(
                { collections: drifted.length, indexes: result.summary.missing },
                'index drift: some declared indexes do not exist in this database'
            );
        }

        // Truncation is reported rather than swallowed: "no drift found" and "the sweep ran
        // out of budget before it looked" must not read the same way in a log.
        if (result.truncated) {
            logger().warn(
                { notReached: result.notReached.length },
                'index drift: sweep hit its wall-clock budget; some collections were not checked'
            );
        }
    } catch (error) {
        logger().warn({ err: error }, 'index drift: check could not run');
    }
}

/**
 * The fourteen workers and the event consumers, started in one place.
 *
 * Extracted from the boot sequence so the read is short and so `drain()` has a visible
 * counterpart — but note the asymmetry, which is deliberate: this function names each worker
 * because each start carries its own reason, while `stopAllWorkers()` iterates
 * `WORKER_INVENTORY` because stopping carries none. A hand-written STOP list is the thing that
 * silently goes stale; a hand-written START list is the thing the inventory is checked against
 * (`test:system`).
 */
function startBackgroundWork(): void {
    // Analytics: nightly per-vendor aggregation.
    initAggregationScheduler();

    // Billing: plan-expiry handover/downgrade sweep. Its plan.expiring/plan.expired
    // events are consumed by the vendor/agency/agent notification stacks below.
    planExpiryWorker.start();

    // Billing: agent plan → capacity sync (plan.activated drives max_active_shipments)
    // and the agency unterminated-shipment soft-cap monitor (alert only, never blocks).
    registerAgentPlanCapacityConsumer();
    agencyShipmentCapWorker.start();

    // Vendor notifications: in-app + multi-channel dispatch (incl. storage alerts)
    initializeVendorNotificationEventConsumers();

    // Agency notifications: minimal in-app + push dispatch (payout requests only)
    initializeAgencyNotificationEventConsumers();

    // Agent notifications: in-app + multi-channel dispatch (COD cash hand-overs)
    initializeAgentNotificationEventConsumers();

    // Customer notifications: in-app + multi-channel dispatch (bookings + orders).
    // The customer was the only party the platform never told anything — see
    // customer-notification.model.ts.
    initializeCustomerNotificationEventConsumers();

    // Storage lifecycle: daily file-cleanup sweep (detach → delete → alert)
    fileCleanupWorker.start();

    // Earnings: daily auto-confirm of stale deliveries + release of matured escrow holds
    earningsReleaseWorker.start();

    // Orders: daily auto-cancel of orders left unpaid past each vendor's window
    unpaidOrderCancelWorker.start();

    // Bookings: release slots held by confirmed-but-unpaid bookings. Without this a
    // customer can reserve a vendor's whole week for free and never pay.
    unpaidBookingCancelWorker.start();

    // Bookings: remind customers ~24h before their appointment. The platform
    // records `no-show` against them, so it owes them the reminder first.
    bookingReminderWorker.start();

    // Bookings: cache each vendor's EXTERNAL calendar commitments so availability
    // does not hit Google on every request. Availability unions these cached blocks
    // with a live query, so a stale block can only ever over-block briefly (the
    // sync soft-deletes removed events, which self-heals) and never under-block.
    // The exported singleton, not a fresh instance. A locally-constructed worker is unreachable
    // by anything else, so the operations surface could not report on the one actually running.
    inboundCalendarSyncWorker.start();

    // COD: daily flagging of agents holding cash past the deposit deadline
    codDepositDeadlineWorker.start();

    // Payments: re-verify mobile-money transactions whose callback never arrived.
    // A USSD confirmation lands minutes after the request that opened it, by which
    // time the customer has closed the page — so the callback IS the settlement
    // path, and a dropped one is money taken for an order that stays unpaid.
    paymentReconciliationWorker.start();

    // Live tracking: stream the outbox to the geo-tracker service so it can revoke tracking on
    // completion. There is no subscriber to register any more — the outbox row is written by
    // `TrackingOutboxEmitter` inside the transaction that changed the shipment (plan step
    // 3.A.1, X-1), because the event bus can carry no session and swallows the failure when a
    // post-commit enqueue is lost.
    trackingDispatchWorker.start();
    // …and the backstop for the one event with no recovery path on geo-tracker's side: a
    // tracking REVOCATION the dispatcher has already parked as `failed` is re-pushed until it
    // lands, because nothing else ever corrects it (plan step 3.A.3).
    trackingAllowReconcileWorker.start();

    // Agent-acceptance workflow: auto-assignment subscriber (shipment.assigned →
    // offer top candidate when the agency opts in) + the offer-expiry sweep.
    initializeShipmentAssignment();

    // Agent capacity: nightly reconcile of the admission-control counter from
    // live shipment counts, correcting any drift from a missed reserve/release.
    agentCapacityReconcileWorker.start();

    // Agent trust: nightly recompute of the composite score. ⚠ SHADOW — it writes
    // `trust_signals.composite_score` and never `cod.trust_score`, which
    // `CodTrustService.applyEvent` still owns. Phase 6 D-2; the flip is Step 11.
    agentTrustRecomputeWorker.start();
}

/**
 * Close everything, in order. Every step below is placed where it is for a reason.
 *
 *   1. **Workers first, before Mongo closes.** A tick in flight when the connection goes away
 *      throws inside a timer callback — the one place in this process with no handler above
 *      it — so an unhandled rejection there would take the process down MID-DRAIN and turn a
 *      clean shutdown into the abrupt one this function exists to prevent.
 *   2. **The listener, with `closeIdleConnections()`.** `server.close()` alone waits for every
 *      open socket, and a keep-alive socket sitting idle between requests never closes on its
 *      own — without this the drain reliably hits its deadline and force-exits.
 *   3. **Wait for in-flight sweeps.** Not "release the locks" — see `awaitWorkerLocksReleased`.
 *      Nothing new can start by this point; the timers are gone.
 *   4. **Flush the log sink**, which writes to Mongo, so it must precede the disconnect.
 *   5. **Mongo, then Redis.**
 *
 * Deliberately does NOT call `process.exit` — the caller decides. That is what keeps the
 * sequence assertable from a test that must survive it.
 *
 * @returns true when the drain completed cleanly, false when it was already running, already
 *          done, or failed.
 */
export async function drain(reason: string): Promise<boolean> {
    // A second SIGTERM, or an impatient operator's Ctrl-C, must not start a parallel
    // sequence that closes connections the first one is still using.
    if (draining) {
        logger().warn({ reason }, 'drain already in progress — ignoring');
        return false;
    }
    // And a drain that has ALREADY FINISHED must not run again. The signal path cannot reach
    // this (`drainThenExit` exits immediately after), but `drain()` is exported and directly
    // callable — and a second pass would flush the log sink into a Mongo connection this
    // function has already closed. Latched on success only: a FAILED drain leaves the process
    // in an unknown state and is worth retrying.
    if (drained) {
        logger().warn({ reason }, 'drain already completed — ignoring');
        return false;
    }
    draining = true;

    const log = logger();
    log.info({ reason }, 'shutdown initiated');

    try {
        const workers = await stopAllWorkers();
        if (workers.failed.length > 0) {
            log.error({ failed: workers.failed }, 'some workers did not stop cleanly');
        }
        log.info({ stopped: workers.stopped }, 'background workers stopped');

        if (httpServer) {
            const server = httpServer;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections();
            });
            httpServer = null;
            log.info('http server closed to new connections');
        }

        // A sweep that was already running when the signal arrived still holds its lock. Wait
        // for it rather than yanking the connection out from under a money path mid-write.
        const released = await awaitWorkerLocksReleased(SYSTEM_CONFIG.SHUTDOWN_TIMEOUT_MS / 2);
        if (!released) {
            // Named, because the next instance's refused sweep is otherwise unexplainable.
            log.warn(
                { held: locksHeldInProcess() },
                'shut down with sweeps still in flight — their Redis locks expire on TTL',
            );
        }

        // Best-effort log writes are issued without being awaited by their request, so closing
        // the connection first would cancel exactly the lines somebody reads after an incident.
        await logMongoSink.flush();

        await mongoose.disconnect();
        await closeRedisClients();

        drained = true;
        log.info({ reason }, 'shutdown complete');
        return true;
    } catch (error) {
        logger().error(
            { err: error instanceof Error ? error.message : String(error) },
            'error during shutdown',
        );
        return false;
    } finally {
        draining = false;
    }
}

/**
 * Reads the timeout without risking a throw: after an early crash configuration may never
 * have validated, and touching it here could throw again, masking the original failure.
 */
function safeShutdownTimeout(): number {
    try {
        return SYSTEM_CONFIG.SHUTDOWN_TIMEOUT_MS;
    } catch {
        return 10_000;
    }
}

/** Drain, then exit — with a hard deadline so a stuck dependency cannot hang the process. */
async function drainThenExit(reason: string, exitCode: number): Promise<void> {
    const timeoutMs = safeShutdownTimeout();

    const forceExit = setTimeout(() => {
        logger().error({ timeoutMs }, 'shutdown timed out — forcing exit');
        process.exit(1);
    }, timeoutMs);
    forceExit.unref();

    const clean = await drain(reason);
    clearTimeout(forceExit);
    process.exit(clean ? exitCode : 1);
}

export function registerShutdownHandlers(): void {
    // NOTE: on Windows 'SIGTERM' is never emitted — the OS has no such signal and Node
    // terminates the process outright. These handlers are for the Linux runtime, which is why
    // `drain()` is exported and exercised directly on the development machine.
    process.on('SIGTERM', () => void drainThenExit('SIGTERM', 0));
    process.on('SIGINT', () => void drainThenExit('SIGINT', 0));

    // An unhandled rejection leaves the process in an unknown state. Draining and exiting
    // non-zero lets the orchestrator replace the instance; continuing risks serving requests
    // from a process whose invariants no longer hold. Node's default for an unhandled
    // rejection is already to terminate — this makes the termination orderly rather than
    // dropping every in-flight request and leaving a sweep's lock held.
    process.on('unhandledRejection', (reason) => {
        logger().fatal(
            { err: reason instanceof Error ? reason.stack : String(reason) },
            'unhandled rejection',
        );
        void drainThenExit('unhandledRejection', 1);
    });

    process.on('uncaughtException', (error) => {
        logger().fatal({ err: error.stack }, 'uncaught exception');
        void drainThenExit('uncaughtException', 1);
    });
}
