import { ObservableWorker, WorkerSchedule, describeSchedule } from '../../core/jobs/worker-schedule';
import { planExpiryWorker } from '../billing/workers/plan-expiry.worker';
import { agencyShipmentCapWorker } from '../billing/workers/agency-shipment-cap.worker';
import { fileCleanupWorker } from '../file-cleanup/workers/file-cleanup.worker';
import { earningsReleaseWorker } from '../earnings/workers/earnings-release.worker';
import { unpaidOrderCancelWorker } from '../orders/workers/unpaid-order-cancel.worker';
import { unpaidBookingCancelWorker } from '../booking/workers/unpaid-booking-cancel.worker';
import { bookingReminderWorker } from '../booking/workers/booking-reminder.worker';
import { inboundCalendarSyncWorker } from '../booking/workers/inbound-calendar-sync.worker';
import { codDepositDeadlineWorker } from '../cod/workers/cod-deposit-deadline.worker';
import { trackingDispatchWorker } from '../tracking-integration/workers/tracking-dispatch.worker';
import { agentCapacityReconcileWorker } from '../agents/workers/agent-capacity-reconcile.worker';
import { assignmentSweepWorker } from '../shipment-assignment/workers/offer-expiry.worker';
import { analyticsAggregationWorker } from '../../core/jobs/aggregation-scheduler';
import { maintenanceBlocksWorkers } from '../system/services/maintenance.service';

/**
 * The background workers, in two exports that answer two different questions.
 *
 *   WORKER_INVENTORY   every worker that exists — what it is, when it runs, whether it is on,
 *                      and whether it is doing something right now. An OBSERVATION.
 *   WORKER_REGISTRY    the subset an administrator may run on demand. A CAPABILITY.
 *
 * ── Why they had to be separated ──────────────────────────────────────────────
 * There was one list, and it was the triggerable one, so "exists" and "can be triggered" were
 * the same question. Two workers fell through that gap:
 *
 *   AssignmentSweepWorker      absent by oversight — the list was written from `server.ts`'s
 *                              import block, and this one starts indirectly via
 *                              `initializeShipmentAssignment()`. It is the ONLY thing advancing
 *                              auto-assignment sessions and expiring manual offers, so a stuck
 *                              sweep was invisible from every angle in the system. Now in both.
 *   InboundCalendarSyncWorker  absent DELIBERATELY, and correctly: its work splits across two
 *                              private methods with different horizons and it holds per-instance
 *                              state, so "run it once" has no single honest meaning. It stays out
 *                              of `WORKER_REGISTRY` — but an operator could not previously see
 *                              that it exists at all, which is a different problem. Now in the
 *                              inventory, with `triggerable: false` and the reason on the wire.
 *
 * ── What triggering one actually means ────────────────────────────────────────
 * These act on LIVE data and are idempotent only to the degree each sweep already was. That is
 * why the permission behind them (`developer_tools.workers.trigger`) is `destructive`, tier-1
 * only, and audited on every call.
 *
 * What it no longer means, since F-19: landing on top of a scheduled tick. Every `runOnce`
 * adapter below calls its worker's ordinary entry point, and that entry point takes the shared
 * overlap lock (`core/jobs/worker-lock.ts`) — so a trigger arriving mid-sweep is refused and
 * returns having done nothing, rather than running a second concurrent pass. The refusal is
 * reported (`ran: false`), not swallowed.
 *
 * Note the deliberate asymmetry with the maintenance guard, which sits at the *tick* site so an
 * operator CAN run a worker inside a maintenance window (ADR-014 D-4). Maintenance is a policy an
 * operator may override; overlap is a correctness constraint and an operator's intent does not
 * make two concurrent writes to the same earnings row safe.
 */

export interface WorkerRunResult {
    /**
     * Did the pass actually run?
     *
     * False when the shared overlap lock refused it — the sweep was already running here or on
     * another instance (F-19). Without this field the endpoint would return "Expired plans
     * processed" for a trigger that did nothing, which is the same class of lie as the schedule
     * strings that were wrong for eight of ten workers.
     */
    ran: boolean;
    /** How many items the pass handled, when the worker reports one. */
    processed?: number;
    /** Anything worth showing the operator that a count cannot express. */
    note?: string;
}

export interface WorkerEntry {
    label: string;
    /** The live worker, for `schedules` / `scheduled` / `executing` / `enabled`. */
    worker: ObservableWorker;
    /** One pass, now. Each adapter absorbs its worker's own method name and return shape. */
    runOnce: () => Promise<WorkerRunResult>;
}

export interface WorkerInventoryEntry {
    key: string;
    label: string;
    worker: ObservableWorker;
    triggerable: boolean;
    /** Why not, when `triggerable` is false. Null otherwise. */
    notTriggerableReason: string | null;
}

/**
 * The note every refused trigger carries. One string, so the endpoint's contract is one string.
 */
const SKIPPED_NOTE =
    'Not run — this sweep was already in progress, here or on another instance. '
    + 'Nothing was changed. Try again once it finishes.';

/**
 * Countless sweeps report no count rather than a fake zero.
 *
 * A `processed: 0` would read as "there was nothing to do", which is a different statement from
 * "this worker does not say". The endpoint renders the absence honestly.
 *
 * These now return a boolean rather than `void`: `true` ran, `false` was refused by the overlap
 * lock. Same reasoning one level up — "refused" and "ran and found nothing" must not print the
 * same sentence.
 */
async function runVoidSweep(run: () => Promise<boolean>, note: string): Promise<WorkerRunResult> {
    const ran = await run();
    return ran ? { ran: true, note } : { ran: false, note: SKIPPED_NOTE };
}

/** The same, for the sweeps that report a count. `null` from one of them means refused. */
async function runCountedSweep(run: () => Promise<number | null>): Promise<WorkerRunResult> {
    const processed = await run();
    return processed === null ? { ran: false, note: SKIPPED_NOTE } : { ran: true, processed };
}

/**
 * The triggerable workers.
 *
 * Note what is NOT here any more: a `schedule` string. It used to be hand-typed and was **wrong
 * for eight of these ten entries**. Each worker now derives its own schedule from the value it
 * actually schedules with, so there is nowhere left to type a literal that could drift. See
 * `core/jobs/worker-schedule.ts`.
 */
export const WORKER_REGISTRY = Object.freeze({
    'plan-expiry': {
        label: 'Plan expiry',
        worker: planExpiryWorker,
        runOnce: () => runVoidSweep(
            () => planExpiryWorker.runSweep(),
            'Expired plans processed; expiring-soon notices sent',
        ),
    },
    'agency-shipment-cap': {
        label: 'Agency shipment cap',
        worker: agencyShipmentCapWorker,
        runOnce: () => runVoidSweep(
            () => agencyShipmentCapWorker.runSweep(),
            'Monthly shipment allowances recomputed',
        ),
    },
    'file-cleanup': {
        label: 'Orphaned file cleanup',
        worker: fileCleanupWorker,
        runOnce: () => runVoidSweep(
            () => fileCleanupWorker.runSweep(),
            'Unreferenced files swept',
        ),
    },
    'earnings-release': {
        label: 'Earnings release',
        worker: earningsReleaseWorker,
        runOnce: () => runVoidSweep(
            () => earningsReleaseWorker.runSweep(),
            'Matured earnings released; missed splits recovered',
        ),
    },
    'unpaid-order-cancel': {
        label: 'Unpaid order cancellation',
        worker: unpaidOrderCancelWorker,
        runOnce: () => runVoidSweep(
            () => unpaidOrderCancelWorker.runSweep(),
            'Orders past their payment window cancelled',
        ),
    },
    'unpaid-booking-cancel': {
        label: 'Unpaid booking cancellation',
        worker: unpaidBookingCancelWorker,
        runOnce: () => runCountedSweep(() => unpaidBookingCancelWorker.sweep()),
    },
    'booking-reminder': {
        label: 'Booking reminders',
        worker: bookingReminderWorker,
        runOnce: () => runCountedSweep(() => bookingReminderWorker.sweep()),
    },
    'cod-deposit-deadline': {
        label: 'COD deposit deadlines',
        worker: codDepositDeadlineWorker,
        runOnce: () => runVoidSweep(
            () => codDepositDeadlineWorker.runSweep(),
            'Late-deposit flags and trust penalties applied',
        ),
    },
    'tracking-dispatch': {
        label: 'Tracking outbox dispatch',
        worker: trackingDispatchWorker,
        runOnce: () => runVoidSweep(
            () => trackingDispatchWorker.drainOnce(),
            'One drain pass over the tracking outbox',
        ),
    },
    'agent-capacity-reconcile': {
        label: 'Agent capacity reconciliation',
        worker: agentCapacityReconcileWorker,
        runOnce: () => runVoidSweep(
            () => agentCapacityReconcileWorker.runSweep(),
            'Active-shipment counters reconciled against reality',
        ),
    },
    /**
     * Added this phase. `sweepOnce()` already had an overlap guard of its own — since F-19 it is
     * the shared one — and crucially this is **the same singleton
     * `initializeShipmentAssignment()` starts**, so `scheduled`/`executing` describe the running
     * worker and a manual trigger goes through its guard rather than around it.
     */
    'assignment-sweep': {
        label: 'Assignment sweep (sessions + offer expiry)',
        worker: assignmentSweepWorker,
        runOnce: () => runVoidSweep(
            () => assignmentSweepWorker.sweepOnce(),
            'One pass: due sessions advanced, due manual offers expired',
        ),
    },
    /**
     * Added in Phase 15, and it is the THIRTEENTH worker — this one was not merely missing from
     * the registry, it was invisible to every surface in the service: no inventory entry, no
     * stop handle, a hardcoded schedule, and no maintenance guard. See
     * `core/jobs/aggregation-scheduler.ts`.
     *
     * Genuinely triggerable, unlike `inbound-calendar-sync`: `runOnce()` is one idempotent pass
     * over yesterday, so "run it once" has a single honest meaning.
     */
    'analytics-aggregation': {
        label: 'Vendor analytics aggregation (daily)',
        worker: analyticsAggregationWorker,
        runOnce: async () => {
            const result = await analyticsAggregationWorker.runOnce();
            if (result === null) return { ran: false, note: SKIPPED_NOTE };
            return {
                ran: true,
                processed: result.vendors,
                note: `${result.vendors} vendor(s) aggregated, ${result.failures} failed`,
            };
        },
    },
} as const satisfies Record<string, WorkerEntry>);

export type WorkerKey = keyof typeof WORKER_REGISTRY;

export const WORKER_KEYS = Object.keys(WORKER_REGISTRY) as [WorkerKey, ...WorkerKey[]];

export function isWorkerKey(value: unknown): value is WorkerKey {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(WORKER_REGISTRY, value);
}

const NOT_TRIGGERABLE: ReadonlyArray<WorkerInventoryEntry> = Object.freeze([
    {
        key: 'inbound-calendar-sync',
        label: 'Inbound calendar sync',
        worker: inboundCalendarSyncWorker,
        triggerable: false,
        notTriggerableReason:
            'Two sync horizons behind private methods plus per-instance state — "run it once" '
            + 'has no single meaning, so no honest one-pass adapter exists.',
    },
]);

/** Every worker that exists, triggerable or not. */
export const WORKER_INVENTORY: ReadonlyArray<WorkerInventoryEntry> = Object.freeze([
    ...WORKER_KEYS.map((key) => ({
        key: key as string,
        label: WORKER_REGISTRY[key].label,
        worker: WORKER_REGISTRY[key].worker as ObservableWorker,
        triggerable: true,
        notTriggerableReason: null,
    })),
    ...NOT_TRIGGERABLE,
]);

export interface WorkerReport {
    key: string;
    label: string;
    schedules: WorkerSchedule[];
    /** Human rendering, derived — never a stored string. */
    scheduleLabel: string;
    enabled: boolean;
    scheduled: boolean;
    executing: boolean;
    manualClaim: boolean;
    triggerable: boolean;
    notTriggerableReason: string | null;
    /** True when a `down` maintenance window is making ticks skip. */
    pausedByMaintenance: boolean;
}

/**
 * The full observation, for `GET /api/internal/admin/system/workers`.
 *
 * `pausedByMaintenance` matters more than it looks: without it an operator in a maintenance
 * window sees `scheduled: true, executing: false` forever and concludes the worker is broken.
 */
export function describeWorkers(): WorkerReport[] {
    const claimed = new Set<string>(manuallyClaimedWorkers());
    const paused = maintenanceBlocksWorkers();

    return WORKER_INVENTORY.map((entry) => ({
        key: entry.key,
        label: entry.label,
        schedules: entry.worker.schedules,
        scheduleLabel: entry.worker.schedules.map(describeSchedule).join(' · '),
        enabled: entry.worker.enabled,
        scheduled: entry.worker.scheduled,
        executing: entry.worker.executing,
        manualClaim: claimed.has(entry.key),
        triggerable: entry.triggerable,
        notTriggerableReason: entry.notTriggerableReason,
        pausedByMaintenance: paused && entry.worker.scheduled,
    }));
}

/**
 * Which workers an operator has triggered and that have not finished.
 *
 * ⚠ **In-process only, and it is not the safety mechanism.** With more than one jovi-mall
 * instance behind a load balancer this claim does NOT hold: two administrators hitting two
 * instances both pass it. That is fine now — the cross-instance guarantee moved to
 * `core/jobs/worker-lock.ts` (the Redis `SET NX` this docstring used to list as a follow-up), and
 * the second trigger is refused *by the worker* with `ran: false`.
 *
 * What this set is still for is the UI: `manualClaim` tells an operator that somebody on this
 * instance pressed the button and it has not come back. Keep the two separate — a claim is who
 * asked, a lock is what is permitted, and collapsing them loses the first.
 *
 * Renamed from `runningWorkers()`. The old name was the third distinct meaning of "running" in
 * this codebase and the one `GET /dev-tools/workers` happened to report — so a scheduled sweep
 * churning away for ten minutes showed `running: false`.
 */
const claimed = new Set<WorkerKey>();

export function tryClaimWorker(key: WorkerKey): boolean {
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
}

export function releaseWorker(key: WorkerKey): void {
    claimed.delete(key);
}

export function manuallyClaimedWorkers(): WorkerKey[] {
    return [...claimed];
}
