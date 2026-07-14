import cron from 'node-cron';
import { COD_CONFIG, daysAgo } from '../config/cod.config';
import { CodCashAccountModel } from '../models/cod-cash-account.model';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodDiscrepancyService, codDiscrepancyService } from '../services/cod-discrepancy.service';

/**
 * CodDepositDeadlineWorker - daily idempotent sweep that flags agents sitting
 * on collected cash past the deposit deadline: opens a `late_deposit`
 * discrepancy (one open per agent — unique partial index) and applies the
 * trust penalty once per opened discrepancy.
 *
 * "Age of the cash still held" is derived FIFO-style: deposits are assumed to
 * pay off the OLDEST collections first, so the outstanding balance maps to the
 * NEWEST collections — we walk them newest-first until they cover the balance;
 * the oldest collection in that covering set anchors the age.
 *
 * Lifecycle mirrors `EarningsReleaseWorker` (node-cron, daily, batched).
 */
export class CodDepositDeadlineWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(
    private readonly discrepancies: CodDiscrepancyService = codDiscrepancyService
  ) {}

  /** Schedule the daily sweep (default 04:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[CodDepositDeadlineWorker] Already started');
      return;
    }
    this.task = cron.schedule(COD_CONFIG.DEPOSIT_SWEEP_CRON, () => {
      void this.runSweep();
    });
    console.log(
      `[CodDepositDeadlineWorker] Scheduled daily deposit-deadline sweep (${COD_CONFIG.DEPOSIT_SWEEP_CRON})`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    console.log('[CodDepositDeadlineWorker] Starting deposit-deadline sweep');
    const cutoff = daysAgo(COD_CONFIG.DEPOSIT_DEADLINE_DAYS, now);
    let flagged = 0;

    const holders = await CodCashAccountModel.find({ owner_type: 'agent', balance: { $gt: 0 } })
      .limit(COD_CONFIG.BATCH_SIZE);

    for (const account of holders) {
      try {
        const agentId = account.owner_id.toString();
        const anchor = await this.oldestHeldCashDate(agentId, account.balance);
        if (!anchor || anchor.collectedAt > cutoff) continue; // within deadline

        const opened = await this.discrepancies.openLateDeposit(
          agentId,
          anchor.agencyId,
          account.balance,
          account.currency
        );
        if (opened) flagged++;
      } catch (error) {
        console.error(
          `[CodDepositDeadlineWorker] Failed to evaluate agent account ${account._id.toString()}:`,
          error
        );
      }
    }

    console.log(`[CodDepositDeadlineWorker] Sweep complete — flagged ${flagged} agent(s)`);
  }

  /**
   * FIFO age anchor: walk collected collections newest-first until they cover
   * the outstanding balance; return the oldest one in that covering set.
   */
  private async oldestHeldCashDate(
    agentId: string,
    balance: number
  ): Promise<{ collectedAt: Date; agencyId: string } | null> {
    const collections = await CashCollectionModel.find({ agent_id: agentId, status: 'collected' })
      .sort({ collected_at: -1 })
      .select('expected_amount collected_at agency_id')
      .limit(500);

    let covered = 0;
    let anchor: { collectedAt: Date; agencyId: string } | null = null;
    for (const c of collections) {
      if (!c.collected_at) continue;
      covered += c.expected_amount;
      anchor = { collectedAt: c.collected_at, agencyId: c.agency_id.toString() };
      if (covered >= balance) break;
    }
    return anchor;
  }
}

export const codDepositDeadlineWorker = new CodDepositDeadlineWorker();
