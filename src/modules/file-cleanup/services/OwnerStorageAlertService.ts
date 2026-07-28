import { eventBus } from '../../../core/events/event-bus';
import { FileCleanupConfig } from '../../../config/file-cleanup.config';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';
import { mediaStorageService } from '../../catalog/domain/services/media/MediaStorageService';
import { entitlementService } from '../../billing/services/entitlement.service';
import { BillingOwnerType } from '../../billing/billing.types';

export interface OwnerAlertStageResult {
  ownersChecked: number;
  alertsRaised: number;
}

/**
 * OwnerStorageAlertService — storage alerts for agency & agent owners.
 *
 * The agency/agent counterpart to the vendor-only StorageAlertService. For each
 * active owner it compares media usage (MediaStorageService, which is
 * owner-type aware) against the plan-driven cap (EntitlementService) and, when
 * usage crosses a configured threshold, publishes the owner's storage-alert
 * event (handled by that role's notification pipeline).
 *
 * Only the HIGHEST crossed threshold is alerted, and the idempotency key buckets
 * by month, so an owner over a band is re-alerted at most once per month and
 * escalates immediately when they cross a higher band — same semantics as the
 * vendor sweep.
 */
export class OwnerStorageAlertService {
  constructor(
    private readonly ownerType: Extract<BillingOwnerType, 'agency' | 'agent'>,
    /** Domain event to publish, e.g. 'agency.storage.alert' / 'agent.storage.alert'. */
    private readonly eventName: string,
    /** Returns the ids of active (non-deleted) owners to check this sweep. */
    private readonly listActiveOwnerIds: () => Promise<string[]>,
    private readonly audit: CleanupAuditRepository,
    private readonly config: FileCleanupConfig,
  ) {}

  async run(sweepId: string, now: Date = new Date()): Promise<OwnerAlertStageResult> {
    const result: OwnerAlertStageResult = { ownersChecked: 0, alertsRaised: 0 };
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const ownerIds = await this.listActiveOwnerIds();

    for (const ownerId of ownerIds) {
      result.ownersChecked += 1;

      try {
        const usageBytes = await mediaStorageService.getUsedBytes(this.ownerType, ownerId);
        if (usageBytes <= 0) continue;

        const limitBytes = await entitlementService.resolveMaxStorageBytes(this.ownerType, ownerId);
        if (limitBytes <= 0) continue;

        const percentUsed = Math.floor((usageBytes / limitBytes) * 100);
        const threshold = this.highestCrossedThreshold(percentUsed);
        if (threshold === null) continue;

        const idempotencyKey = `${this.eventName}:${ownerId}:${threshold}:${period}`;

        if (!this.config.dryRun) {
          await eventBus.publish(this.eventName, {
            eventType: this.eventName,
            aggregateId: ownerId,
            occurredAt: now,
            payload: {
              ownerType: this.ownerType,
              ownerId,
              usageBytes,
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
          entityType: this.ownerType,
          entityId: ownerId,
          reason: `usage ${percentUsed}% ≥ ${threshold}% threshold`,
          metadata: { usageBytes, limitBytes, percentUsed, threshold },
        });
        result.alertsRaised += 1;
      } catch (error) {
        console.error(`[OwnerStorageAlert:${this.ownerType}] Failed for ${ownerId}:`, error);
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
