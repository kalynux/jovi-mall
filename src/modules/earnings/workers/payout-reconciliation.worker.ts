import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import { PayoutRequestModel } from '../models/payout-request.model';
import { payoutRequestService } from '../services/payout-request.service';
import { findPaymentGateway } from '../../payments/gateways/registry';
import { PaymentGatewayName } from '../../payments/gateways/gateway.interface';
import { reconcileStuckPayouts, StuckPayout, PayoutReconcileTally } from '../domain/payout-reconciliation';

/**
 * PayoutReconciliationWorker — the sweep that closes a payout whose transfer callback never
 * arrived. The payout twin of `payments/workers/payment-reconciliation.worker.ts`.
 *
 * What it decides, and why, is in `domain/payout-reconciliation.ts`; this file only selects the
 * rows and wires the two effects. In one line: ask the gateway that SENT the transfer, through
 * `verifyPayout`, and apply a sure verdict through `applyTransferOutcome` — the callback's own
 * path, so the two cannot both settle one payout.
 *
 * ── Which rows ───────────────────────────────────────────────────────────────
 * `processing`, with a provider transfer id, quiet for at least MIN_AGE and younger than
 * MAX_AGE. A row with no transfer id was never acknowledged by the gateway (the send timed out)
 * and cannot be asked about — My-CoolPay, for one, has no lookup by our reference — so it is
 * excluded here and resolved by an administrator instead. Served by `{ status, created_at }`.
 */
export class PayoutReconciliationWorker implements ObservableWorker {
    private task: ReturnType<typeof cron.schedule> | null = null;
    private sweeping = false;

    get schedules(): WorkerSchedule[] {
        // Derived from the value actually scheduled with, never a hand-typed string.
        return [{ kind: 'cron', expression: EARNINGS_CONFIG.PAYOUT_RECONCILE_CRON, source: 'PAYOUT_RECONCILE_CRON' }];
    }

    get scheduled(): boolean {
        return this.task !== null;
    }

    get executing(): boolean {
        return this.sweeping;
    }

    get enabled(): boolean {
        return true;
    }

    start(): void {
        if (this.task) {
            console.log('[PayoutReconciliationWorker] Already started');
            return;
        }
        this.task = cron.schedule(EARNINGS_CONFIG.PAYOUT_RECONCILE_CRON, () => {
            if (maintenanceBlocksWorkers()) return;
            void this.runSweep();
        });
        console.log(
            `[PayoutReconciliationWorker] Scheduled payout reconciliation sweep (${EARNINGS_CONFIG.PAYOUT_RECONCILE_CRON})`
        );
    }

    stop(): void {
        this.task?.stop();
        this.task = null;
    }

    /**
     * Run the sweep once. Safe to call manually and concurrently — a second caller is refused by
     * the shared worker lock rather than queued, because two passes would ask twice about the
     * same transfer (harmless, since settlement is a compare-and-set, but wasteful).
     *
     * Returns null when refused; otherwise the number of payouts RESOLVED (settled + failed).
     * `0` means nothing was resolved, which is a different statement from "did not run".
     */
    async runSweep(now: Date = new Date()): Promise<number | null> {
        const outcome = await withWorkerLock('payout-reconciliation', async () => {
            this.sweeping = true;
            try {
                const tally = await this.reconcile(now);
                if (tally.checked > 0) {
                    console.log(`[PayoutReconciliationWorker] Sweep complete — ${describeTally(tally)}`);
                }
                return tally.settled + tally.failed;
            } finally {
                this.sweeping = false;
            }
        });
        return outcome === SWEEP_SKIPPED ? null : outcome;
    }

    private async reconcile(now: Date): Promise<PayoutReconcileTally> {
        const rows = await PayoutRequestModel.find({
            status: 'processing',
            transfer_gateway_ref: { $nin: ['', null] },
            updated_at: { $lt: new Date(now.getTime() - EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES * 60_000) },
            created_at: { $gt: new Date(now.getTime() - EARNINGS_CONFIG.PAYOUT_RECONCILE_MAX_AGE_HOURS * 3_600_000) },
        })
            .sort({ updated_at: 1 })
            .limit(EARNINGS_CONFIG.PAYOUT_RECONCILE_BATCH_SIZE)
            .select('_id transfer_gateway transfer_reference transfer_gateway_ref')
            .lean();

        const stuck: StuckPayout[] = rows.map((row) => ({
            id: row._id.toString(),
            transfer_gateway: (row.transfer_gateway ?? null) as PaymentGatewayName | null,
            transfer_reference: row.transfer_reference ?? null,
            transfer_gateway_ref: row.transfer_gateway_ref as string,
        }));

        return reconcileStuckPayouts(stuck, {
            gatewayFor: (name) => findPaymentGateway(name),
            applyTransferOutcome: (id, outcome) => payoutRequestService.applyTransferOutcome(id, outcome),
            log: (line) => console.warn(`[PayoutReconciliationWorker] ${line}`),
        });
    }
}

function describeTally(t: PayoutReconcileTally): string {
    return `checked ${t.checked}: ${t.settled} paid, ${t.failed} failed (hold kept), ${t.pending} still pending, `
        + `${t.alreadyResolved} already resolved, ${t.unsupported} not askable, ${t.errors} error(s)`;
}

export const payoutReconciliationWorker = new PayoutReconciliationWorker();
