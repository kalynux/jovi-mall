// Must run before any app module is imported so env-driven config read at import
// time (e.g. credit pricing in the billing module) sees the .env values.
import 'dotenv/config';
import mongoose from 'mongoose';
import { app } from './app';
import { initAggregationScheduler } from './core/jobs/aggregation-scheduler';
import { planExpiryWorker } from './modules/billing/workers/plan-expiry.worker';
import { registerPlanNotificationConsumer } from './modules/billing/events/plan-notification.consumer';
import { initializeVendorNotificationEventConsumers } from './modules/notifications/vendor-notification-event-consumer';
import { fileCleanupWorker } from './modules/file-cleanup/workers/file-cleanup.worker';
import { earningsReleaseWorker } from './modules/earnings/workers/earnings-release.worker';

const PORT = process.env.PORT || 8022;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

async function startServer() {
  try {
    // Database Connection
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Initialize scheduled jobs
    initAggregationScheduler();

    // Billing: plan-expiry handover/downgrade sweep + expiry notifications
    registerPlanNotificationConsumer();
    planExpiryWorker.start();

    // Vendor notifications: in-app + multi-channel dispatch (incl. storage alerts)
    initializeVendorNotificationEventConsumers();

    // Storage lifecycle: daily file-cleanup sweep (detach → delete → alert)
    fileCleanupWorker.start();

    // Earnings: daily auto-confirm of stale deliveries + release of matured escrow holds
    earningsReleaseWorker.start();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
