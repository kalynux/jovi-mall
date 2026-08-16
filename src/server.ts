// Must run before any app module is imported so env-driven config read at import
// time (e.g. credit pricing in the billing module) sees the .env values.
import 'dotenv/config';
// import dotenv from 'dotenv';
// dotenv.config();
import mongoose from 'mongoose';
import { app } from './app';
import { initLogging, enableLogPersistence, logger } from './core/logging';
import { assertSigningSecrets } from './config/secrets.config';
import { assertEnvironment } from './config/env';
import { assertInternalAdminToken } from './config/internal-admin.config';
import { assertExposedConfigSafe } from './modules/system/domain/exposed-config';
import { reportBotWebhookGuard } from './api/middlewares/bot-webhook.middleware';
import { initAggregationScheduler } from './core/jobs/aggregation-scheduler';
import { initializeMetrics, installOutboxDepthProvider, recordMongoError } from './modules/system/metrics/metrics';
import { outboxDepthForMetrics } from './modules/system/services/queue-depth.service';
import { primeMaintenanceState } from './modules/system/services/maintenance.service';
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
import { registerTrackingEventSubscriber } from './modules/tracking-integration/services/tracking-event-subscriber';
import { trackingDispatchWorker } from './modules/tracking-integration/workers/tracking-dispatch.worker';
import { initializeAgentDomain } from './modules/agents';
import { initializeShipmentAssignment } from './modules/shipment-assignment';
import { agentCapacityReconcileWorker } from './modules/agents/workers/agent-capacity-reconcile.worker';
import { initRateLimiters } from './api/rate-limit/rate-limit.middleware';


const PORT = process.env.PORT || 8022;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

async function startServer() {
  try {
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
    // Reports rather than asserts, because the guard's unset behaviour differs by
    // environment: production refuses every bot webhook, development leaves them open.
    // Either way an operator should read it in the boot log rather than discover it —
    // `/connect` mints a credential, so "are the bot webhooks authenticated?" is now a
    // question with a security answer. See api/middlewares/bot-webhook.middleware.ts.
    reportBotWebhookGuard((message) => console.log(message));

    // Database Connection
    await mongoose.connect(MONGO_URI);
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
    // thirteen of those, and a poller would run the aggregation whether or not anyone is
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

    // Initialize scheduled jobs
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

    // Live tracking: write shipment-lifecycle events to the outbox and stream
    // them to the geo-tracker service so it can revoke tracking on completion.
    registerTrackingEventSubscriber();
    trackingDispatchWorker.start();

    // Agent-acceptance workflow: auto-assignment subscriber (shipment.assigned →
    // offer top candidate when the agency opts in) + the offer-expiry sweep.
    initializeShipmentAssignment();

    // Agent capacity: nightly reconcile of the admission-control counter from
    // live shipment counts, correcting any drift from a missed reserve/release.
    agentCapacityReconcileWorker.start();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
