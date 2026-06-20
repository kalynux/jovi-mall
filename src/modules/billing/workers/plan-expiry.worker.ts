import cron from 'node-cron';
import { eventBus } from '../../../core/events/event-bus';
import { VendorPlanRepository } from '../repositories/vendor-plan.repository';
import { VendorPlanService, vendorPlanService } from '../services/vendor-plan.service';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';

const DAY_MS = 86_400_000;
/** Upper bound on per-vendor notify windows (matches the setting's max). */
const MAX_NOTIFY_WINDOW_DAYS = 90;

/**
 * PlanExpiryWorker - daily sweep that:
 *  1. Hands over expired active paid plans to their queued pending plan, or
 *     downgrades them to the free tier when nothing is queued.
 *  2. Emits a `vendor.plan.expiring` event when a plan crosses into the vendor's
 *     configured notification window (fires once, on that day).
 *
 * Lifecycle mirrors the analytics aggregation scheduler (node-cron, daily).
 * Idempotent: re-running the same day produces no duplicate transitions.
 */
export class PlanExpiryWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(
    private readonly vendorPlanRepo: VendorPlanRepository = new VendorPlanRepository(),
    private readonly plans: VendorPlanService = vendorPlanService,
    private readonly settingsRepo: VendorSettingsRepository = new VendorSettingsRepository()
  ) {}

  /** Schedule the daily sweep (03:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[PlanExpiryWorker] Already started');
      return;
    }
    this.task = cron.schedule('0 3 * * *', () => {
      void this.runSweep();
    });
    console.log('[PlanExpiryWorker] Scheduled daily plan-expiry sweep (03:00)');
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the full sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    console.log('[PlanExpiryWorker] Starting plan-expiry sweep');
    await this.processExpired(now);
    await this.processExpiringSoon(now);
    console.log('[PlanExpiryWorker] Plan-expiry sweep complete');
  }

  private async processExpired(now: Date): Promise<void> {
    const expired = await this.vendorPlanRepo.findExpiredActive(now);
    for (const plan of expired) {
      const vendorId = plan.vendor_id.toString();
      try {
        const activated = await this.plans.activatePending(vendorId, plan._id);
        if (!activated) {
          await this.plans.downgradeToFree(vendorId, plan._id);
        }
        await eventBus.publish('vendor.plan.expired', {
          eventType: 'vendor.plan.expired',
          aggregateId: vendorId,
          occurredAt: now,
          payload: {
            vendorId,
            expiredPlanCode: plan.plan_code,
            handedOverToPending: !!activated,
            newPlanCode: activated?.plan_code ?? 'starter',
          },
        });
      } catch (err) {
        console.error(`[PlanExpiryWorker] Failed to transition expired plan for vendor ${vendorId}:`, err);
      }
    }
  }

  private async processExpiringSoon(now: Date): Promise<void> {
    const horizon = new Date(now.getTime() + MAX_NOTIFY_WINDOW_DAYS * DAY_MS);
    const upcoming = await this.vendorPlanRepo.findActiveExpiringBefore(horizon);
    for (const plan of upcoming) {
      if (!plan.expires_at) continue;
      const vendorId = plan.vendor_id.toString();
      try {
        const notifyDays = await this.settingsRepo.getNotifyDaysBeforeExpiry(vendorId);
        const daysUntil = Math.ceil((plan.expires_at.getTime() - now.getTime()) / DAY_MS);
        // Fire once, on the day the plan crosses into the notice window.
        if (daysUntil === notifyDays) {
          await eventBus.publish('vendor.plan.expiring', {
            eventType: 'vendor.plan.expiring',
            aggregateId: vendorId,
            occurredAt: now,
            payload: {
              vendorId,
              planCode: plan.plan_code,
              expiresAt: plan.expires_at,
              daysUntilExpiry: daysUntil,
            },
          });
        }
      } catch (err) {
        console.error(`[PlanExpiryWorker] Failed expiry-notice check for vendor ${vendorId}:`, err);
      }
    }
  }
}

export const planExpiryWorker = new PlanExpiryWorker();
