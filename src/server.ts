// Must run before any app module is imported so env-driven config read at import
// time (e.g. credit pricing in the billing module) sees the .env values.
import 'dotenv/config';
// import dotenv from 'dotenv';
// dotenv.config();
import mongoose from 'mongoose';
import { app } from './app';
import { initAggregationScheduler } from './core/jobs/aggregation-scheduler';
import { planExpiryWorker } from './modules/billing/workers/plan-expiry.worker';
import { registerPlanNotificationConsumer } from './modules/billing/events/plan-notification.consumer';
import { initializeVendorNotificationEventConsumers } from './modules/notifications/vendor-notification-event-consumer';
import { initializeAgencyNotificationEventConsumers } from './modules/notifications/agency-notification-event-consumer';
import { initializeAgentNotificationEventConsumers } from './modules/notifications/agent-notification-event-consumer';
import { fileCleanupWorker } from './modules/file-cleanup/workers/file-cleanup.worker';
import { earningsReleaseWorker } from './modules/earnings/workers/earnings-release.worker';
import { unpaidOrderCancelWorker } from './modules/orders/workers/unpaid-order-cancel.worker';
import { codDepositDeadlineWorker } from './modules/cod/workers/cod-deposit-deadline.worker';
import { registerTrackingEventSubscriber } from './modules/tracking-integration/services/tracking-event-subscriber';
import { trackingDispatchWorker } from './modules/tracking-integration/workers/tracking-dispatch.worker';
import { initializeAgentDomain } from './modules/agents';
import { initializeShipmentAssignment } from './modules/shipment-assignment';
import { agentCapacityReconcileWorker } from './modules/agents/workers/agent-capacity-reconcile.worker';


const PORT = process.env.PORT || 8022;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

async function startServer() {
  try {
    // Database Connection
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Agent domain: installs the device-location provider behind the
    // eligibility rules. Must run before any dispatch path evaluates an agent;
    // swapping in geo-tracker's provider later is a change HERE and nowhere else.
    initializeAgentDomain();

    // Initialize scheduled jobs
    initAggregationScheduler();

    // Billing: plan-expiry handover/downgrade sweep + expiry notifications
    registerPlanNotificationConsumer();
    planExpiryWorker.start();

    // Vendor notifications: in-app + multi-channel dispatch (incl. storage alerts)
    initializeVendorNotificationEventConsumers();

    // Agency notifications: minimal in-app + push dispatch (payout requests only)
    initializeAgencyNotificationEventConsumers();

    // Agent notifications: in-app + multi-channel dispatch (COD cash hand-overs)
    initializeAgentNotificationEventConsumers();

    // Storage lifecycle: daily file-cleanup sweep (detach → delete → alert)
    fileCleanupWorker.start();

    // Earnings: daily auto-confirm of stale deliveries + release of matured escrow holds
    earningsReleaseWorker.start();

    // Orders: daily auto-cancel of orders left unpaid past each vendor's window
    unpaidOrderCancelWorker.start();

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
