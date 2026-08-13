import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { eventBus } from '../../../core/events/event-bus';
import { SubscriberPlanRepository } from '../repositories/subscriber-plan.repository';
import { SubscriberPlanService, subscriberPlanService } from '../services/subscriber-plan.service';
import { BillingSettingsRepository } from '../repositories/billing-settings.repository';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { BillingOwnerType, freePlanCode } from '../billing.types';

const DAY_MS = 86_400_000;
/** Upper bound on per-owner notify windows (matches the setting's max). */
const MAX_NOTIFY_WINDOW_DAYS = 90;

/**
 * PlanExpiryWorker - daily sweep, for EVERY owner type (vendor/agency/agent):
 *  1. Hands over expired active paid plans to their queued pending plan, or
 *     downgrades them to the role's free tier when nothing is queued.
 *  2. Emits a `plan.expiring` event when a plan crosses into the owner's
 *     configured notification window (fires once, on that day).
 *
 * Lifecycle mirrors the analytics aggregation scheduler (node-cron, daily).
 * Idempotent: re-running the same day produces no duplicate transitions.
 */
export class PlanExpiryWorker implements ObservableWorker {
  /**
   * The one place this cadence is written. `start()` schedules with it and `schedules` reports
   * it, so the operator-facing answer cannot drift from the scheduled one — which it did, for
   * this exact worker (the registry advertised `daily 00:05`). See `core/jobs/worker-schedule.ts`.
   */
  static readonly CRON = '0 3 * * *';

  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: PlanExpiryWorker.CRON, source: 'hardcoded' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  /** Observation only — this worker has no overlap guard. See `ObservableWorker`. */
  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return true;
  }

  constructor(
    private readonly planRepo: SubscriberPlanRepository = new SubscriberPlanRepository(),
    private readonly plans: SubscriberPlanService = subscriberPlanService,
    private readonly billingSettings: BillingSettingsRepository = new BillingSettingsRepository(),
    private readonly vendorSettings: VendorSettingsRepository = new VendorSettingsRepository()
  ) {}

  /** Schedule the daily sweep (03:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[PlanExpiryWorker] Already started');
      return;
    }
    this.task = cron.schedule(PlanExpiryWorker.CRON, () => {
      if (maintenanceBlocksWorkers()) return;
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
    // Flag only — deliberately NOT an early return. Adding an overlap guard here would change
    // scheduling behaviour on a live sweep; this phase makes the condition observable and
    // leaves the fix to its own decision. See `ObservableWorker`.
    this.sweeping = true;
    try {
      console.log('[PlanExpiryWorker] Starting plan-expiry sweep');
      await this.processExpired(now);
      await this.processExpiringSoon(now);
      console.log('[PlanExpiryWorker] Plan-expiry sweep complete');
    } finally {
      this.sweeping = false;
    }
  }

  private async processExpired(now: Date): Promise<void> {
    const expired = await this.planRepo.findExpiredActive(now);
    for (const plan of expired) {
      const ownerType = plan.owner_type;
      const ownerId = plan.owner_id.toString();
      try {
        const activated = await this.plans.activatePending(ownerType, ownerId, plan._id);
        if (!activated) {
          await this.plans.downgradeToFree(ownerType, ownerId, plan._id);
        }
        await eventBus.publish('plan.expired', {
          eventType: 'plan.expired',
          aggregateId: ownerId,
          occurredAt: now,
          payload: {
            ownerType,
            ownerId,
            expiredPlanCode: plan.plan_code,
            handedOverToPending: !!activated,
            newPlanCode: activated?.plan_code ?? freePlanCode(ownerType),
          },
        });
      } catch (err) {
        console.error(`[PlanExpiryWorker] Failed to transition expired plan for ${ownerType} ${ownerId}:`, err);
      }
    }
  }

  private async processExpiringSoon(now: Date): Promise<void> {
    const horizon = new Date(now.getTime() + MAX_NOTIFY_WINDOW_DAYS * DAY_MS);
    const upcoming = await this.planRepo.findActiveExpiringBefore(horizon);
    for (const plan of upcoming) {
      if (!plan.expires_at) continue;
      const ownerType = plan.owner_type;
      const ownerId = plan.owner_id.toString();
      try {
        const notifyDays = await this.getNotifyDays(ownerType, ownerId);
        const daysUntil = Math.ceil((plan.expires_at.getTime() - now.getTime()) / DAY_MS);
        // Fire once, on the day the plan crosses into the notice window.
        if (daysUntil === notifyDays) {
          await eventBus.publish('plan.expiring', {
            eventType: 'plan.expiring',
            aggregateId: ownerId,
            occurredAt: now,
            payload: {
              ownerType,
              ownerId,
              planCode: plan.plan_code,
              expiresAt: plan.expires_at,
              daysUntilExpiry: daysUntil,
            },
          });
        }
      } catch (err) {
        console.error(`[PlanExpiryWorker] Failed expiry-notice check for ${ownerType} ${ownerId}:`, err);
      }
    }
  }

  /** Vendors keep their preference on VendorSettings; agency/agent use BillingSettings. */
  private async getNotifyDays(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
    if (ownerType === 'vendor') {
      return this.vendorSettings.getNotifyDaysBeforeExpiry(ownerId);
    }
    return this.billingSettings.getNotifyDaysBeforeExpiry(ownerType, ownerId);
  }
}

export const planExpiryWorker = new PlanExpiryWorker();
