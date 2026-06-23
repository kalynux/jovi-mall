import cron from 'node-cron';
import { transactionManager } from '../../../core/database/transaction.manager';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from '../services/earnings-account.service';
import { OrderModel } from '../../orders/order.model';
import { OrderCompletionService, orderCompletionService } from '../../orders/order-completion.service';
import { EARNINGS_CONFIG, daysAgo } from '../config/earnings.config';

/**
 * EarningsReleaseWorker - daily sweep with two idempotent stages:
 *
 *  1. Auto-confirm: orders that reached `delivered`/`fulfilled` but were never
 *     confirmed by the customer within `AUTO_CONFIRM_DAYS` are auto-completed
 *     (which starts their escrow hold window).
 *  2. Release: held allocations whose `hold_release_at` has elapsed move from
 *     `pending_balance` to `available_balance` (withdrawable).
 *
 * Lifecycle mirrors `PlanExpiryWorker`/`FileCleanupWorker` (node-cron, daily).
 * Both stages are safe to re-run: completion is guarded by `completion.confirmed_at`
 * and release by an atomic `held → released` claim.
 */
export class EarningsReleaseWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly orderCompletion: OrderCompletionService = orderCompletionService
  ) {}

  /** Schedule the daily sweep (default 01:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[EarningsReleaseWorker] Already started');
      return;
    }
    this.task = cron.schedule(EARNINGS_CONFIG.CRON, () => {
      void this.runSweep();
    });
    console.log(`[EarningsReleaseWorker] Scheduled daily earnings sweep (${EARNINGS_CONFIG.CRON})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the full sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    console.log('[EarningsReleaseWorker] Starting earnings sweep');
    await this.autoConfirmStaleOrders(now);
    await this.releaseMaturedHolds(now);
    console.log('[EarningsReleaseWorker] Earnings sweep complete');
  }

  /** Stage 1 — auto-confirm delivered/fulfilled orders past the window. */
  private async autoConfirmStaleOrders(now: Date): Promise<void> {
    const cutoff = daysAgo(EARNINGS_CONFIG.AUTO_CONFIRM_DAYS, now);
    const stale = await OrderModel.find({
      fulfillment_status: { $in: ['delivered', 'fulfilled'] },
      'completion.confirmed_at': null,
      updated_at: { $lte: cutoff },
    }).limit(EARNINGS_CONFIG.BATCH_SIZE);

    for (const order of stale) {
      try {
        await this.orderCompletion.complete(order, 'system', true);
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to auto-confirm order ${order._id.toString()}:`,
          error
        );
      }
    }
  }

  /** Stage 2 — release matured held allocations into available balances. */
  private async releaseMaturedHolds(now: Date): Promise<void> {
    const matured = await this.allocationRepo.findMaturedHeld(now, EARNINGS_CONFIG.BATCH_SIZE);

    for (const allocation of matured) {
      try {
        await transactionManager.runInTransaction(async (session) => {
          // Atomically claim the allocation; null means another sweep already
          // released/reversed it — skip to stay idempotent.
          const claimed = await this.allocationRepo.markReleased(allocation._id, new Date(), session);
          if (!claimed) return;
          await this.accounts.releaseInSession(claimed, session);
        });
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to release allocation ${allocation._id.toString()}:`,
          error
        );
      }
    }
  }
}

export const earningsReleaseWorker = new EarningsReleaseWorker();
