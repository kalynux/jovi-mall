/**
 * npm run aggregate:analytics — run the nightly vendor-analytics pass once, now.
 *
 * Same code as the `analytics-aggregation` worker (and `POST /dev-tools/workers/analytics-aggregation/run`):
 * fills every finished day not yet covered, up to a year back, plus the last two days again,
 * into `vendor_money_daily`. Idempotent — safe to re-run. Use it after a deploy so the first
 * dashboard loads do not compute a year live.
 *
 * Replaces `scripts/populate-vendor-analytics.ts` (2026-09-27), which filled the retired
 * `vendor_daily_metrics` one vendor and one range at a time.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { analyticsAggregationWorker } from '../src/core/jobs/aggregation-scheduler';

async function main(): Promise<void> {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set');
    await mongoose.connect(uri);
    try {
        const result = await analyticsAggregationWorker.runOnce();
        console.log(result === null ? 'Skipped: another pass holds the worker lock.' : result);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
