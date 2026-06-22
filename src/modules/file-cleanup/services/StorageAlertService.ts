import { VendorModel } from '../../vendors/vendor.model';
import { eventBus } from '../../../core/events/event-bus';
import { FileCleanupConfig } from '../../../config/file-cleanup.config';
import { StorageUsageService } from './StorageUsageService';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';

export interface AlertStageResult {
  vendorsChecked: number;
  alertsRaised: number;
}

/**
 * StorageAlertService — Stage: storage alerts.
 *
 * For each active vendor, compares media usage against their plan cap and, when
 * usage crosses a configured threshold, publishes `vendor.storage.alert` (handled
 * by the notification pipeline → in-app + email/telegram).
 *
 * Only the HIGHEST crossed threshold is alerted, so a vendor at 95% gets one
 * "90%" alert rather than one per band. The idempotency key buckets by month, so
 * a vendor that stays over a band is re-alerted at most once per month, and
 * escalates immediately when they cross a higher band.
 */
export class StorageAlertService {
  constructor(
    private readonly storageUsage: StorageUsageService,
    private readonly audit: CleanupAuditRepository,
    private readonly config: FileCleanupConfig,
  ) {}

  async run(sweepId: string, now: Date = new Date()): Promise<AlertStageResult> {
    const result: AlertStageResult = { vendorsChecked: 0, alertsRaised: 0 };
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const vendors = await VendorModel.find({ status: 'active' }).select('_id').lean();

    for (const vendor of vendors) {
      result.vendorsChecked += 1;
      const vendorId = vendor._id.toString();

      try {
        const usage = await this.storageUsage.getVendorUsage(vendorId);
        if (usage.totalSize <= 0) continue;

        const limitBytes = await this.storageUsage.getVendorLimitBytes(
          vendorId,
          this.config.defaultStorageLimitBytes,
        );
        if (limitBytes <= 0) continue;

        const percentUsed = Math.floor((usage.totalSize / limitBytes) * 100);
        const threshold = this.highestCrossedThreshold(percentUsed);
        if (threshold === null) continue;

        const idempotencyKey = `storage.alert:${vendorId}:${threshold}:${period}`;

        if (!this.config.dryRun) {
          await eventBus.publish('vendor.storage.alert', {
            eventType: 'vendor.storage.alert',
            aggregateId: vendorId,
            occurredAt: now,
            payload: {
              vendorId,
              usageBytes: usage.totalSize,
              limitBytes,
              percentUsed,
              threshold,
              idempotencyKey,
            },
          });
        }

        await this.audit.record({
          sweepId,
          stage: 'storage_alert',
          action: 'alert',
          dryRun: this.config.dryRun,
          vendorId,
          reason: `usage ${percentUsed}% ≥ ${threshold}% threshold`,
          metadata: { usageBytes: usage.totalSize, limitBytes, percentUsed, threshold },
        });
        result.alertsRaised += 1;
      } catch (error) {
        console.error(`[StorageAlert] Failed for vendor ${vendorId}:`, error);
      }
    }

    return result;
  }

  /** Highest configured threshold that `percentUsed` has reached, or null. */
  private highestCrossedThreshold(percentUsed: number): number | null {
    let crossed: number | null = null;
    for (const threshold of this.config.alertThresholds) {
      if (percentUsed >= threshold) crossed = threshold;
    }
    return crossed;
  }
}
