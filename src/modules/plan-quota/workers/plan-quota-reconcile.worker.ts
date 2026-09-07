import cron from 'node-cron';
import { Types } from 'mongoose';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../../billing/billing.types';
import { SubscriberPlanRepository } from '../../billing/repositories/subscriber-plan.repository';
import { PricingPlanRepository } from '../../billing/repositories/pricing-plan.repository';
import { ProductModel, PLAN_QUOTA_REASONS } from '../../catalog/models/product.model';
import { FileModel } from '../../catalog/models/file.model';
import { PlanQuotaStateModel } from '../models/plan-quota-state.model';
import { PlanQuotaEnforcementService, planQuotaEnforcementService } from '../domain/services/plan-quota-enforcement.service';
import { PLAN_QUOTA_CONFIG } from '../config/plan-quota.config';

/**
 * PlanQuotaReconcileWorker — the durability guarantee behind plan-quota enforcement.
 *
 * ── Why a sweep exists at all ────────────────────────────────────────────────────
 * Enforcement is normally immediate: `plan.activated` fires, the consumer recomputes,
 * done within a second. But that event rides `core/events/event-bus.ts` — in-memory,
 * per-process, no persistence, no retry, and `publish` swallows handler errors. A
 * process restart between the plan commit and the handler, or a handler that throws,
 * loses the enforcement **silently and permanently**: the vendor keeps a hundred live
 * products on a fifteen-product plan and nothing anywhere disagrees.
 *
 * The codebase's standing answer to that is an outbox row written inside the producing
 * transaction. It is not needed here, because **the authority is already committed
 * transactionally** — the `subscriber_plans` row. So rather than replaying a queued
 * instruction, this sweep compares what each owner's suspensions were computed *for*
 * (`plan_quota_states`) against the plan they are actually on, and recomputes wherever
 * the two disagree. Nothing can be lost because nothing is queued; a dropped event costs
 * one cron interval.
 *
 * The sweep picks an owner up for either of two reasons, and BOTH are needed.
 *
 * **Their stamp has drifted from their plan.** That catches three distinct faults:
 *
 *   1. a lost or failed `plan.activated` — ids differ;
 *   2. an owner never enforced at all — no state row (this is also what makes the
 *      feature apply to every existing owner on the day it ships, with no backfill);
 *   3. ⚠ **an administrator editing a live plan** — `PATCH /billing/plans/:id` changes
 *      `max_active_products` on the plan every subscriber already points at, so no
 *      `plan_id` anywhere changes and `PricingPlanService.update` emits no event at all.
 *      Only the stamped limit VALUES catch this, and it is the case that silently
 *      re-tiers an entire cohort at once.
 *
 * **Or they are currently holding something back** (`ownersHoldingQuotaState`). Drift
 * alone would be a real hole: the remedy the platform offers an over-cap owner is
 * "archive something older and the next item returns", and archiving changes neither the
 * plan nor its limits — so a drift-only sweep would skip that vendor forever and their
 * suspended product would wait for a plan change that may never come.
 *
 * Owners who are neither drifted nor holding anything are skipped without their catalog
 * being touched, so the steady-state cost is one indexed read per active plan.
 */
export class PlanQuotaReconcileWorker implements ObservableWorker {
    private task: ReturnType<typeof cron.schedule> | null = null;
    private sweeping = false;
    private readonly schedule = PLAN_QUOTA_CONFIG.RECONCILE_CRON;

    get schedules(): WorkerSchedule[] {
        return [{ kind: 'cron', expression: this.schedule, source: 'PLAN_QUOTA_RECONCILE_CRON' }];
    }

    get scheduled(): boolean {
        return this.task !== null;
    }

    get executing(): boolean {
        return this.sweeping;
    }

    get enabled(): boolean {
        return PLAN_QUOTA_CONFIG.RECONCILE_ENABLED;
    }

    constructor(
        private readonly enforcement: PlanQuotaEnforcementService = planQuotaEnforcementService,
        private readonly planRepo: SubscriberPlanRepository = new SubscriberPlanRepository(),
        private readonly pricingRepo: PricingPlanRepository = new PricingPlanRepository(),
    ) { }

    start(): void {
        if (this.task) {
            console.log('[PlanQuotaReconcileWorker] Already started');
            return;
        }
        if (!this.enabled) {
            console.log('[PlanQuotaReconcileWorker] Disabled by PLAN_QUOTA_RECONCILE_ENABLED');
            return;
        }
        this.task = cron.schedule(this.schedule, () => {
            if (maintenanceBlocksWorkers()) return;
            void this.runSweep();
        });
        console.log(`[PlanQuotaReconcileWorker] Scheduled plan-quota drift sweep (${this.schedule})`);
    }

    stop(): void {
        this.task?.stop();
        this.task = null;
    }

    /**
     * Run the full sweep once. Safe to call manually.
     *
     * Returns the number of owners actually recomputed, or `null` when another instance
     * held the lock — `null` means REFUSED and `0` means "nothing had drifted", which are
     * different statements and must stay distinguishable (see `core/jobs/worker-lock.ts`).
     */
    async runSweep(): Promise<number | null> {
        const outcome = await withWorkerLock('plan-quota-reconcile', async () => {
            this.sweeping = true;
            try {
                return await this.sweepAllOwners();
            } finally {
                this.sweeping = false;
            }
        });
        return outcome === SWEEP_SKIPPED ? null : (outcome as number);
    }

    private async sweepAllOwners(): Promise<number> {
        let recomputed = 0;
        const holding = await this.ownersHoldingQuotaState();

        for (const ownerType of BILLING_OWNER_TYPES) {
            const assignments = await this.planRepo.findAllActiveByOwnerType(ownerType);

            for (const assignment of assignments) {
                const ownerId = assignment.owner_id.toString();
                try {
                    const needsPass =
                        holding.has(`${ownerType}:${ownerId}`) ||
                        (await this.hasDrifted(ownerType, ownerId, assignment.plan_id.toString()));
                    if (!needsPass) continue;

                    await this.enforcement.reconcileOwner(ownerType, ownerId);
                    recomputed += 1;
                } catch (err) {
                    // One owner's failure must not end the sweep — the next pass retries them,
                    // and stopping here would leave every owner after them unenforced too.
                    console.error(`[PlanQuotaReconcileWorker] Failed for ${ownerType} ${ownerId}:`, err);
                }
            }
        }

        return recomputed;
    }

    /**
     * Every owner who currently has something held back by the quota.
     *
     * ⚠ **Drift alone is not enough, and this set is what makes the promised remedy
     * real.** The owner-facing rule is "archive or delete something older and the next
     * item comes back" — but archiving changes no plan and no limit, so `hasDrifted`
     * returns false and a drift-only sweep would skip that vendor forever. Their
     * suspended product would wait for a plan change that may never come.
     *
     * Recomputing everyone instead would mean walking every owner's whole catalog and
     * media library nightly. This set is the small one that matters: only owners who are
     * actually over cap hold anything, and for everybody else the pass is skipped.
     *
     * Two `distinct` reads rather than a per-owner existence check, so the cost is two
     * queries per sweep instead of two per owner.
     */
    private async ownersHoldingQuotaState(): Promise<Set<string>> {
        const holding = new Set<string>();

        const suspendedVendorIds = await ProductModel.distinct('vendorId', {
            status: 'suspended',
            'suspension.reason': PLAN_QUOTA_REASONS[0],
            deletedAt: null,
        });
        for (const id of suspendedVendorIds) holding.add(`vendor:${id.toString()}`);

        const blocked = await FileModel.aggregate<{ _id: { ownerType: string; ownerId: Types.ObjectId } }>([
            { $match: { quotaBlockedAt: { $ne: null }, deletedAt: null } },
            { $group: { _id: { ownerType: '$ownerType', ownerId: '$ownerId' } } },
        ]);
        for (const row of blocked) {
            if (!row._id?.ownerType || !row._id?.ownerId) continue;
            holding.add(`${row._id.ownerType}:${row._id.ownerId.toString()}`);
        }

        return holding;
    }

    /**
     * Has this owner's enforced state fallen behind their actual plan?
     *
     * Compares the plan id AND both limit values. The values are what catch a live plan
     * edit, where the id cannot change by construction.
     */
    private async hasDrifted(ownerType: BillingOwnerType, ownerId: string, activePlanId: string): Promise<boolean> {
        if (!Types.ObjectId.isValid(ownerId)) return false;

        const state = await PlanQuotaStateModel.findOne({
            owner_type: ownerType,
            owner_id: new Types.ObjectId(ownerId),
        }).lean();

        // Never enforced — every owner alive on the day this ships takes this branch once.
        if (!state) return true;
        if (state.enforced_plan_id?.toString() !== activePlanId) return true;

        const plan = await this.pricingRepo.findById(activePlanId);
        if (!plan) return false; // Nothing to enforce against; leave the owner alone.

        const expectedMaxProducts = ownerType === 'vendor' ? plan.max_active_products : null;

        // `??` normalises undefined to null so a legacy row without the field compares
        // equal to an unlimited plan rather than drifting on every single sweep.
        return (
            (state.enforced_max_products ?? null) !== expectedMaxProducts ||
            (state.enforced_max_storage_bytes ?? null) !== (plan.max_storage_bytes ?? null)
        );
    }
}

export const planQuotaReconcileWorker = new PlanQuotaReconcileWorker();
