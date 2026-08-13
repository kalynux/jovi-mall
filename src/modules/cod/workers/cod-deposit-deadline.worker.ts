import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { COD_CONFIG, daysAgo } from '../config/cod.config';
import { CashCollectionModel } from '../models/cash-collection.model';
import { AgentDepositModel } from '../models/agent-deposit.model';
import {
  AgentAgencyContractModel,
  ALLOCATING_CONTRACT_STATUSES,
  nextRemittanceDueAt,
} from '../../agents';
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
export class CodDepositDeadlineWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'cron',
      expression: COD_CONFIG.DEPOSIT_SWEEP_CRON,
      source: 'COD_DEPOSIT_SWEEP_CRON',
    }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  /** Observation only — no overlap guard. See `ObservableWorker`. */
  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return true;
  }

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
      if (maintenanceBlocksWorkers()) return;
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
    // Flag only — deliberately NOT an early return. See `ObservableWorker`.
    this.sweeping = true;
    try {
      console.log('[CodDepositDeadlineWorker] Starting deposit-deadline sweep');
      const contracts = await this.flagLateContracts(now);
      const agencies = await this.flagUnansweredDeclarations(now);
      console.log(
        `[CodDepositDeadlineWorker] Sweep complete — flagged ${contracts} contract(s), ${agencies} unanswered declaration(s)`
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Stage 1 — contracts whose cash is past THAT CONTRACT's deadline.
   *
   * ── Why this iterates contracts, not cash accounts ──────────────────────
   *
   * It used to walk `CodCashAccount` rows and compare every agent against one
   * platform-wide `DEPOSIT_DEADLINE_DAYS`. That could not survive the
   * remittance cadence becoming enforced: the agent's cash account is GLOBAL
   * (one pot across every agency) while `remittance_terms` is PER CONTRACT, so
   * there is no single deadline to compare a pot against. An agent settling
   * daily with one agency and monthly with another has two answers.
   *
   * `contract.cod.outstanding_balance` is the per-contract authority — it is
   * already what `AgentDepositService` bounds a deposit by — so each contract
   * is evaluated against its own terms and flagged in its own right.
   *
   * ── What is unchanged ───────────────────────────────────────────────────
   *
   * Cash covered by an OPEN declaration still does not count against the agent:
   * they have said, on the record, that they handed it over and the receiving
   * party has not answered. Penalising them for that would punish the agent for
   * the agency's silence — the exact failure this flow exists to end; stage 2
   * flags the other party instead. A rejected declaration stops covering
   * anything the moment it is rejected, so a false claim cannot stop the clock.
   *
   * The FIFO age anchor is also unchanged in method — only in scope. It was
   * spanning every agency, which was simply wrong once the flag became
   * per-contract.
   */
  private async flagLateContracts(now: Date): Promise<number> {
    let flagged = 0;

    const contracts = await AgentAgencyContractModel.find({
      status: { $in: ALLOCATING_CONTRACT_STATUSES },
      'cod.outstanding_balance': { $gt: 0 },
    }).limit(COD_CONFIG.BATCH_SIZE);

    for (const contract of contracts) {
      try {
        const agentId = contract.agent_id.toString();
        const agencyId = contract.agency_id.toString();

        const declared = await this.deposits.sumOpenDeclarationsForContract(agentId, agencyId);
        const uncovered = (contract.cod?.outstanding_balance ?? 0) - declared;
        if (uncovered <= 0) continue; // every franc is awaiting the agency's answer

        // Anchor on the UNCOVERED amount, not the whole balance: the covered
        // part is not the agent's problem, so it must not drag the age anchor
        // back to a collection they have already declared.
        const anchor = await this.oldestHeldCashDate(agentId, agencyId, uncovered);
        if (!anchor) continue;

        const terms = contract.remittance_terms;
        const dueAt = terms
          ? nextRemittanceDueAt(
              terms.cadence,
              terms.day_of_week,
              terms.day_of_month,
              terms.grace_hours,
              anchor.collectedAt
            )
          : // Pre-refactor rows have no remittance_terms sub-document at all.
            // The platform default survives as their fallback, nothing more.
            new Date(anchor.collectedAt.getTime() + COD_CONFIG.DEPOSIT_DEADLINE_DAYS * 86_400_000);

        // null ⇒ 'on_demand': no schedule, so nothing is ever overdue.
        if (dueAt === null || now <= dueAt) continue;

        const opened = await this.discrepancies.openLateDeposit(
          agentId,
          agencyId,
          uncovered,
          anchor.currency,
          dueAt
        );
        if (opened) flagged++;
      } catch (error) {
        console.error(
          `[CodDepositDeadlineWorker] Failed to evaluate contract ${contract._id.toString()}:`,
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
   * FIFO age anchor for ONE contract: walk that contract's collected
   * collections newest-first until they cover its outstanding balance; return
   * the oldest one in that covering set.
   *
   * Deposits are assumed to pay off the OLDEST collections first, so the
   * balance still outstanding maps to the NEWEST ones — and the oldest in that
   * covering set is the age the deadline is measured from. That reasoning is
   * unchanged; only the `agency_id` scope is new, and it was always the correct
   * scope for a per-contract question.
   *
   * `currency` comes back from the collections themselves rather than from the
   * agent's cash account, so a flag's currency describes the cash it is about.
   */
  private async oldestHeldCashDate(
    agentId: string,
    agencyId: string,
    balance: number
  ): Promise<{ collectedAt: Date; currency: string } | null> {
    const collections = await CashCollectionModel.find({
      agent_id: agentId,
      agency_id: agencyId,
      status: 'collected',
    })
      .sort({ collected_at: -1 })
      .select('expected_amount collected_at currency')
      .limit(500);

    let covered = 0;
    let anchor: { collectedAt: Date; currency: string } | null = null;
    for (const c of collections) {
      if (!c.collected_at) continue;
      covered += c.expected_amount;
      anchor = { collectedAt: c.collected_at, currency: c.currency };
      if (covered >= balance) break;
    }
    return anchor;
  }
}

export const codDepositDeadlineWorker = new CodDepositDeadlineWorker();
