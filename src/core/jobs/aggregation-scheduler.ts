import cron from 'node-cron';
import { VendorModel } from '../../modules/vendors/vendor.model';
import { VendorAnalyticsAggregationService } from '../../modules/vendors/services/vendor-analytics-aggregation.service';
import { subDays } from 'date-fns';

/**
 * Analytics Aggregation Scheduler
 * 
 * Runs daily at 2 AM to aggregate previous day's metrics for all active vendors
 * Uses vendor-specific timezones for accurate date boundary calculations
 */

const aggregationService = new VendorAnalyticsAggregationService();

/**
 * Aggregate previous day's metrics for all active vendors
 */
async function runDailyAggregation() {
    console.log('[Scheduler] Starting daily analytics aggregation');

    try {
        // Fetch all active vendors
        const vendors = await VendorModel.find({ status: 'active' });
        console.log(`[Scheduler] Found ${vendors.length} active vendors`);

        // Get yesterday's date (will be converted to vendor timezone in service)
        const yesterday = subDays(new Date(), 1);

        // Aggregate for each vendor
        for (const vendor of vendors) {
            try {
                const timezone = vendor.timezone || 'Africa/Douala'; // Default fallback
                await aggregationService.aggregateDailyMetrics(
                    vendor._id.toString(),
                    yesterday,
                    timezone
                );
            } catch (error) {
                console.error(`[Scheduler] Failed to aggregate for vendor ${vendor._id}:`, error);
                // Continue with next vendor
            }
        }

        console.log('[Scheduler] Completed daily analytics aggregation');
    } catch (error) {
        console.error('[Scheduler] Fatal error in daily aggregation:', error);
    }
}

/**
 * Initialize aggregation scheduler
 * 
 * Schedule: Daily at 2:00 AM server time
 * Format: 0 2 * * * (minute hour day month weekday)
 */
export function initAggregationScheduler() {
    // Schedule daily at 2 AM
    cron.schedule('0 2 * * *', async () => {
        await runDailyAggregation();
    });

    console.log('[Scheduler] Analytics aggregation scheduler initialized (daily at 2 AM)');
}
