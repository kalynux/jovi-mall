import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { PAYMENTS_CONFIG } from '../config/payments.config';
import { PaymentTransactionModel } from '../models/payment-transaction.model';
import { PlanPurchaseModel } from '../../billing/models/plan-purchase.model';
import { CreditTopupModel } from '../../billing/models/credit-topup.model';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';
import { getPaymentGateway } from '../gateways/registry';

/**
 * PaymentReconciliationWorker — the sweep that closes a payment whose callback
 * never arrived.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A mobile-money confirmation arrives minutes after the request that opened it,
 * by which time the customer has usually closed the page. So the callback is
 * the primary settlement path and client polling is not a substitute for it —
 * which means a callback that never lands is money taken for an order that
 * stays unpaid, forever, with nothing looking.
 *
 * Nothing swept `payment_transaction` before this. The two existing sweepers
 * (`unpaid-order-cancel.worker.ts` and its booking twin) look at orders and
 * bookings and never at the transaction, so a row stuck at PENDING stayed there
 * until a human noticed. That is the state B-3 describes, and it is why this
 * worker is the pairing for the status-code fix rather than an optimisation.
 *
 * ── WHAT IT DOES AND DOES NOT DECIDE ─────────────────────────────────────────
 * It asks the gateway and applies the gateway's answer through the SAME
 * `verifyPayment` path a client poll uses. It never infers: an unreachable
 * provider leaves the row exactly as it was, because "we could not ask" is not
 * "it failed", and marking it failed would abandon money that settled.
 *
 * Both age bounds matter. `MIN_AGE` is a settling window — re-verifying a
 * thirty-second-old transaction only spends gateway quota on a payment the
 * customer is still completing. `MAX_AGE` stops the sweep re-querying the whole
 * history forever; anything older is `npm run audit:stuck-payments`, not a job
 * that runs every ten minutes.
 */
export class PaymentReconciliationWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;

  constructor(private readonly orchestrator = new PaymentOrchestratorService()) {}

  get schedules(): WorkerSchedule[] {
    // Derived from the value actually scheduled with, never a hand-typed string
    // — the operations surface reported the wrong schedule for eight of ten
    // workers when those were maintained by hand.
    return [
      {
        kind: 'cron',
        expression: PAYMENTS_CONFIG.RECONCILE_CRON,
        source: 'PAYMENT_RECONCILE_CRON',
      },
    ];
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
      console.log('[PaymentReconciliationWorker] Already started');
      return;
    }
    this.task = cron.schedule(PAYMENTS_CONFIG.RECONCILE_CRON, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(
      `[PaymentReconciliationWorker] Scheduled payment reconciliation sweep (${PAYMENTS_CONFIG.RECONCILE_CRON})`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * Run the sweep once. Safe to call manually, and safe to call concurrently —
   * a second caller is refused rather than queued.
   *
   * The lock guard sits INSIDE the sweep rather than at the tick site, which is
   * the convention for a correctness constraint (as opposed to the maintenance
   * guard, which is a policy an operator may override). Overlap here means two
   * passes settling one transaction, and settlement runs the earnings split.
   *
   * Returns null when refused, a count when it ran — `0` means "nothing was
   * due", which is a different statement from "did not run".
   */
  async runSweep(now: Date = new Date()): Promise<number | null> {
    const outcome = await withWorkerLock('payment-reconciliation', async () => {
      this.sweeping = true;
      try {
        const transactions = await this.reconcileTransactions(now);
        const billing = await this.reconcileBilling(now);
        const total = transactions + billing;
        if (total > 0) {
          console.log(
            `[PaymentReconciliationWorker] Sweep complete — reconciled ${transactions} transaction(s), ${billing} billing row(s)`
          );
        }
        return total;
      } finally {
        this.sweeping = false;
      }
    });
    return outcome === SWEEP_SKIPPED ? null : outcome;
  }

  /**
   * Orders, carts and bookings.
   *
   * Deliberately scoped to the mobile-money gateways. Stripe settles
   * synchronously through the Payment Element and its webhook delivery has its
   * own retry with exponential backoff — sweeping it would poll a provider that
   * is already telling us.
   */
  private async reconcileTransactions(now: Date): Promise<number> {
    const stale = await PaymentTransactionModel.find({
      gateway: { $in: ['NOTCHPAY', 'MYCOOLPAY'] },
      status: { $in: ['INITIATED', 'PENDING'] },
      // A transaction with no gateway reference was never successfully opened —
      // there is nothing to ask about.
      gatewayRef: { $nin: ['', null] },
      updatedAt: { $lt: this.minAge(now) },
      createdAt: { $gt: this.maxAge(now) },
    })
      .sort({ updatedAt: 1 })
      .limit(PAYMENTS_CONFIG.RECONCILE_BATCH_SIZE)
      .select('_id');

    let settled = 0;
    for (const row of stale) {
      try {
        // Through `verifyPayment` rather than a direct gateway call, so a
        // success runs `handlePaymentSuccess` on the one path — fulfilment,
        // stock commit and the earnings split included.
        const result = await this.orchestrator.verifyPayment(row._id.toString());
        if (result.status === 'SUCCEEDED') settled += 1;
      } catch (error) {
        // One bad row must not stop the batch: the next transaction may be the
        // one holding somebody's delivery.
        console.error(
          `[PaymentReconciliationWorker] Failed to reconcile ${row._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    return settled;
  }

  /**
   * Plan purchases and credit top-ups.
   *
   * These carry no `PaymentTransaction` at all, which is why they need their own
   * pass — and why, before the merchant reference existed, a mobile-money
   * billing callback had nowhere to land and only a client that stayed on the
   * page ever completed one.
   */
  private async reconcileBilling(now: Date): Promise<number> {
    const filter = {
      gateway: { $in: ['NOTCHPAY', 'MYCOOLPAY'] },
      status: 'pending',
      gateway_ref: { $nin: ['', null] },
      updated_at: { $lt: this.minAge(now) },
      created_at: { $gt: this.maxAge(now) },
    };

    let settled = 0;

    const purchases = await PlanPurchaseModel.find(filter)
      .sort({ updated_at: 1 })
      .limit(PAYMENTS_CONFIG.RECONCILE_BATCH_SIZE);
    for (const purchase of purchases) {
      try {
        const adapter = getPaymentGateway(purchase.gateway!);
        const verification = await adapter.verifyPayment({ gatewayRef: purchase.gateway_ref! });
        if (verification.status === 'SUCCEEDED') {
          await planPurchaseService.completePurchase(purchase._id.toString());
          settled += 1;
        } else if (verification.status === 'FAILED' || verification.status === 'CANCELLED') {
          await planPurchaseService.failPurchase(purchase._id.toString());
        }
      } catch (error) {
        console.error(
          `[PaymentReconciliationWorker] Failed to reconcile plan purchase ${purchase._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    const topups = await CreditTopupModel.find(filter)
      .sort({ updated_at: 1 })
      .limit(PAYMENTS_CONFIG.RECONCILE_BATCH_SIZE);
    for (const topup of topups) {
      try {
        const adapter = getPaymentGateway(topup.gateway!);
        const verification = await adapter.verifyPayment({ gatewayRef: topup.gateway_ref! });
        if (verification.status === 'SUCCEEDED') {
          await creditTopupService.completeTopup(topup._id.toString());
          settled += 1;
        } else if (verification.status === 'FAILED' || verification.status === 'CANCELLED') {
          await creditTopupService.failTopup(topup._id.toString());
        }
      } catch (error) {
        console.error(
          `[PaymentReconciliationWorker] Failed to reconcile credit top-up ${topup._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return settled;
  }

  private minAge(now: Date): Date {
    return new Date(now.getTime() - PAYMENTS_CONFIG.RECONCILE_MIN_AGE_MINUTES * 60_000);
  }

  private maxAge(now: Date): Date {
    return new Date(now.getTime() - PAYMENTS_CONFIG.RECONCILE_MAX_AGE_HOURS * 60 * 60_000);
  }
}

export const paymentReconciliationWorker = new PaymentReconciliationWorker();
