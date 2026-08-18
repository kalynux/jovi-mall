#!/usr/bin/env ts-node

/**
 * Manual Analytics Aggregation Script
 * 
 * Usage:
 *   npm run aggregate:analytics -- --vendorId=XXX --from=YYYY-MM-DD --to=YYYY-MM-DD [--force]
 * 
 * Example:
 *   npm run aggregate:analytics -- --vendorId=507f1f77bcf86cd799439011 --from=2026-02-01 --to=2026-02-10 --force
 */

import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';
import { VendorAnalyticsAggregationService } from '../src/modules/vendors/services/vendor-analytics-aggregation.service';
import { VendorModel } from '../src/modules/vendors/vendor.model';
import { StoreRepository } from '../src/modules/store/repositories/store.repository';
import { eachDayOfInterval, parseISO } from 'date-fns';

// `core/database/connection` does not exist — every other script here connects mongoose
// directly, and this one had been importing a module that was never there. It could not
// have run since, and nothing reported it because scripts/ was outside every tsconfig
// until plan step 0.C.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

interface CLIArgs {
    vendorId?: string;
    from?: string;
    to?: string;
    force?: boolean;
}

function parseArgs(): CLIArgs {
    const args: CLIArgs = {};

    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--vendorId=')) {
            args.vendorId = arg.split('=')[1];
        } else if (arg.startsWith('--from=')) {
            args.from = arg.split('=')[1];
        } else if (arg.startsWith('--to=')) {
            args.to = arg.split('=')[1];
        } else if (arg === '--force') {
            args.force = true;
        }
    });

    return args;
}

async function main() {
    const args = parseArgs();

    // Validate required args
    if (!args.vendorId || !args.from || !args.to) {
        console.error('Missing required arguments');
        console.error('Usage: npm run aggregate:analytics -- --vendorId=XXX --from=YYYY-MM-DD --to=YYYY-MM-DD [--force]');
        process.exit(1);
    }

    try {
        // Connect to database
        await mongoose.connect(MONGO_URI);
        console.log('[Script] Connected to database');

        // Fetch vendor
        const vendor = await VendorModel.findById(args.vendorId);
        if (!vendor) {
            console.error(`[Script] Vendor not found: ${args.vendorId}`);
            process.exit(1);
        }

        const timezone = vendor.timezone || 'Africa/Douala';
        // The business name lives on the Store, never on the vendor profile — the vendor
        // holds display_name + avatar only. Resolved through the repository rather than
        // read off `vendor`, which no longer carries `business_name`.
        const store = await new StoreRepository().findByVendorIdOrNull(String(vendor._id));
        console.log(`[Script] Found vendor: ${store?.name ?? String(vendor._id)} (timezone: ${timezone})`);

        // Parse date range
        const fromDate = parseISO(args.from!);
        const toDate = parseISO(args.to!);

        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            console.error('[Script] Invalid date format. Use YYYY-MM-DD');
            process.exit(1);
        }

        if (fromDate > toDate) {
            console.error('[Script] Start date must be before or equal to end date');
            process.exit(1);
        }

        // Generate date range
        const dates = eachDayOfInterval({ start: fromDate, end: toDate });
        console.log(`[Script] Aggregating ${dates.length} days from ${args.from} to ${args.to}`);
        if (args.force) {
            console.log('[Script] Force mode enabled (will override idempotency guard)');
        }

        // Initialize service
        const aggregationService = new VendorAnalyticsAggregationService();

        // Aggregate each day
        let successCount = 0;
        let skipCount = 0;
        let errorCount = 0;

        for (const date of dates) {
            try {
                console.log(`[Script] Aggregating ${date.toISOString().split('T')[0]}...`);
                await aggregationService.aggregateDailyMetrics(
                    args.vendorId!,
                    date,
                    timezone,
                    args.force || false
                );
                successCount++;
            } catch (error: any) {
                if (error.message && error.message.includes('Skipping recent aggregation')) {
                    skipCount++;
                } else {
                    console.error(`[Script] Error aggregating ${date.toISOString().split('T')[0]}:`, error);
                    errorCount++;
                }
            }
        }

        console.log('\n[Script] Aggregation complete:');
        console.log(`  ✅ Successful: ${successCount}`);
        console.log(`  ⏭️  Skipped: ${skipCount}`);
        console.log(`  ❌ Errors: ${errorCount}`);

        process.exit(errorCount > 0 ? 1 : 0);
    } catch (error) {
        console.error('[Script] Fatal error:', error);
        process.exit(1);
    }
}

main();
