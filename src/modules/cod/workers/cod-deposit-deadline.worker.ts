import cron from 'node-cron';
import { COD_CONFIG, daysAgo } from '../config/cod.config';
import { CodCashAccountModel } from '../models/cod-cash-account.model';
import { CashCollectionModel } from '../models/cash-collection.model';
import { AgentDepositModel } from '../models/agent-deposit.model';
import { CodDiscrepancyService, codDiscrepancyService } from '../services/cod-discrepancy.service';
import { AgentDepositService, agentDepositService } from '../services/agent-deposit.service';

/**
 * CodDepositDeadlineWorker - daily idempotent sweep over both sides of the
 * agent↔agency cash handover:
 *
 *  1. Agents sitting on collected cash past the deposit deadline → a
 *     `late_deposit` discrepancy (one open per agent) + the agent trust penalty.
 *  2. Declarations the agency never answered past the confirm deadline →
 *     a `deposit_not_confirmed` discrepancy against the AGENCY (one per
 *     deposit), no trust penalty.
 *
 * The two stages are deliberately symmetric. Cash not moving is a problem
 * whichever party is sitting on it, and before stage 2 existed only the agent
 * could ever be blamed for it.
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
    private readonly discrepancies: CodDiscrepancyService = codDiscrepancyService,
    private readonly deposits: AgentDepositService = agentDepositService
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
    const agents = await this.flagLateAgents(now);
    const agencies = await this.flagUnansweredDeclarations(now);
    console.log(
      `[CodDepositDeadlineWorker] Sweep complete — flagged ${agents} agent(s), ${agencies} unanswered declaration(s)`
    );
  }

  /**
   * Stage 1 — agents sitting on collected cash past the deposit deadline.
   *
   * Cash covered by an OPEN declaration does not count against the agent: they
   * have said, on the record, that they handed it over, and the receiving party
   * has not answered. Penalising them for that would punish the agent for the
   * agency's silence — the exact failure this whole flow exists to end. Stage 2
   * flags the other party instead.
   *
   * A rejected declaration stops covering anything the moment it is rejected, so
   * an agent cannot park a false claim to stop their own clock: the agency's
   * one-click rejection restarts it.
   */
  private async flagLateAgents(now: Date): Promise<number> {
    const cutoff = daysAgo(COD_CONFIG.DEPOSIT_DEADLINE_DAYS, now);
    let flagged = 0;

    const holders = await CodCashAccountModel.find({ owner_type: 'agent', balance: { $gt: 0 } })
      .limit(COD_CONFIG.BATCH_SIZE);

    for (const account of holders) {
      try {
        const agentId = account.owner_id.toString();

        const declared = await this.deposits.sumOpenDeclarationsForAgent(agentId);
        const uncovered = account.balance - declared;
        if (uncovered <= 0) continue; // every franc is awaiting someone else's answer

        // Anchor on the UNCOVERED amount, not the whole balance: the covered
        // part is not the agent's problem, so it must not drag the age anchor
        // back to a collection they have already declared.
        const anchor = await this.oldestHeldCashDate(agentId, uncovered);
        if (!anchor || anchor.collectedAt > cutoff) continue; // within deadline

        const opened = await this.discrepancies.openLateDeposit(
          agentId,
          anchor.agencyId,
          uncovered,
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
    return flagged;
  }

  /**
   * Stage 2 — declarations the AGENCY has neither confirmed nor rejected.
   *
   * Only `recipient: 'agency'` declarations. A platform-bound declaration is the
   * admin's to answer, and flagging an agency for the platform's own backlog
   * would be both unfair and useless — it is an ops queue, not a cash-chain
   * problem. Those surface on the admin deposit list instead.
   */
  private async flagUnansweredDeclarations(now: Date): Promise<number> {
    const cutoff = daysAgo(COD_CONFIG.DEPOSIT_CONFIRM_DEADLINE_DAYS, now);
    let flagged = 0;

    const stale = await AgentDepositModel.find({
      status: 'declared',
      recipient: 'agency',
      declared_at: { $lte: cutoff },
    })
      .sort({ declared_at: 1 })
      .limit(COD_CONFIG.BATCH_SIZE);

    for (const deposit of stale) {
      try {
        const opened = await this.discrepancies.openDepositNotConfirmed({
          id: deposit._id.toString(),
          agentId: deposit.agent_id.toString(),
          agencyId: deposit.agency_id.toString(),
          amount: deposit.amount,
          currency: deposit.currency,
        });
        if (opened) flagged++;
      } catch (error) {
        console.error(
          `[CodDepositDeadlineWorker] Failed to flag unanswered deposit ${deposit._id.toString()}:`,
          error
        );
      }
    }
    return flagged;
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
