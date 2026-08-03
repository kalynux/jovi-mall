import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import {
  AgentDepositModel,
  IAgentDeposit,
  AgentDepositRecipient,
  AgentDepositStatus,
} from '../models/agent-deposit.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodSettlementService, codSettlementService } from './cod-settlement.service';
import { AgentRepository, AgentMembershipRepository } from '../../agents';

/**
 * AgentDepositService - the agent's COD cash going back where it belongs.
 *
 * ── Two recipients, two shapes of the same movement ─────────────────────────
 *
 * 'agency'   — the normal route. Lowers the agent's cash liability and draws
 *              down the contract's outstanding balance. The agency's own
 *              liability to the platform is untouched; that falls when an admin
 *              confirms an AgencyRemittance.
 * 'platform' — the agent paid the platform directly. Does all of the above AND
 *              what a confirmed remittance does: the agency's liability falls
 *              and the cash is FIFO-applied to that agency's collections,
 *              unlocking the earnings they back. The cash physically skipped
 *              the middle leg, so the ledger does too.
 *
 * Both land in the same place — agent 0, agency 0, platform holding the cash —
 * which is why one row can serve both.
 *
 * ── This IS the contract's COD remittance ───────────────────────────────────
 *
 * A deposit is the agent handing back cash under exactly one contract, so it
 * settles that contract rather than being mirrored into a second ledger. That
 * matters more than it looks: `contract.cod.outstanding_balance` is what §4
 * consults before letting a contract end, and what
 * `AgentCodThresholdService.setContractThreshold` refuses to price below. This
 * service is therefore the ONLY thing that releases an agent's COD headroom —
 * without it a pool fills and never drains.
 *
 * ── Why declarations exist ──────────────────────────────────────────────────
 *
 * Recording used to be agency-only and single-step, which made an agency's
 * record of a handover unfalsifiable. An agency that under-recorded (or simply
 * never recorded) left the agent still carrying the liability, still short of
 * headroom, and — after DEPOSIT_DEADLINE_DAYS — wearing a `late_deposit` trust
 * penalty for cash they had already handed over, with no way to say so. The
 * agent can now declare a handover the agency must answer. A declaration moves
 * no money, so it cannot be abused to free headroom; what it does is start a
 * clock the agency has to beat.
 */
export class AgentDepositService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly agentRepo: AgentRepository = new AgentRepository(),
    private readonly memberships: AgentMembershipRepository = new AgentMembershipRepository(),
    private readonly settlement: CodSettlementService = codSettlementService
  ) {}

  // ─── Declaration (the agent's claim) ────────────────────────────────────────

  /**
   * The agent declares a handover. Moves NO money — it is a timestamped claim
   * the receiving party has to answer, exactly like an AgencyRemittance
   * declaration.
   *
   * The amount is validated here as well as at confirmation, purely so the agent
   * finds out immediately rather than after a day of silence. Confirmation
   * re-validates, because balances move in between and only the check inside the
   * confirming transaction is authoritative.
   */
  async declare(params: {
    agentId: string;
    agencyId: string;
    amount: number;
    recipient: AgentDepositRecipient;
    reference?: string | null;
    note?: string | null;
    declaredByUserId: string;
  }): Promise<IAgentDeposit> {
    const { agentId, agencyId, amount, recipient, reference, note, declaredByUserId } = params;

    if (recipient === 'platform' && !reference?.trim()) {
      throw createAppError(
        ERROR_CODES.COD_DEPOSIT_REFERENCE_REQUIRED,
        422,
        'A transfer reference is required when paying the platform directly — it is the only evidence tying the payment to this deposit'
      );
    }

    const { currency } = await this.assertDepositable({ agentId, agencyId, amount, recipient });

    const deposit = await AgentDepositModel.create({
      agent_id: agentId,
      agency_id: agencyId,
      amount,
      currency,
      note: note ?? null,
      recipient,
      status: 'declared',
      reference: reference?.trim() || null,
      declared_by_user_id: declaredByUserId,
      declared_at: new Date(),
    });

    await this.emit('cod.deposit.declared', deposit);
    return deposit;
  }

  // ─── Confirmation (the receiving party answers) ─────────────────────────────

  /**
   * The receiving party confirms it has the cash. THIS is where money moves.
   *
   * `by` is checked against the deposit's recipient rather than trusted from the
   * route: only the agency may confirm cash handed to the agency, and only an
   * admin may confirm cash handed to the platform. An agency confirming a
   * platform deposit would drop its own liability against cash it never saw.
   */
  async confirm(params: {
    depositId: string;
    by: 'agency' | 'admin';
    /** Scope guard — the agency confirming must be the one on the deposit. */
    agencyId?: string;
    confirmedByUserId: string;
  }): Promise<IAgentDeposit> {
    const { depositId, by, agencyId, confirmedByUserId } = params;

    const deposit = await this.loadDeclared(depositId, agencyId);
    this.assertConfirmer(deposit, by);

    // Re-validate against live balances: the declaration may be days old, and
    // the agent may have deposited elsewhere since.
    const { membership } = await this.assertDepositable({
      agentId: deposit.agent_id.toString(),
      agencyId: deposit.agency_id.toString(),
      amount: deposit.amount,
      recipient: deposit.recipient,
    });

    await transactionManager.runInTransaction(async (session) => {
      // Atomic claim: only a still-'declared' deposit can be confirmed, so two
      // agency admins clicking together produce one confirmation, not two
      // draw-downs.
      const claimed = await AgentDepositModel.findOneAndUpdate(
        { _id: depositId, status: 'declared' },
        {
          $set: {
            status: 'confirmed',
            recorded_by_user_id: new Types.ObjectId(confirmedByUserId),
            resolved_at: new Date(),
          },
        },
        { new: true, session }
      );
      if (!claimed) {
        throw createAppError(ERROR_CODES.COD_DEPOSIT_ALREADY_RESOLVED, 409);
      }
      await this.applyInSession(claimed, membership._id.toString(), session);
    });

    const confirmed = (await AgentDepositModel.findById(depositId))!;
    await this.emit('cod.deposit.recorded', confirmed);
    return confirmed;
  }

  /**
   * The receiving party rejects the claim: nothing arrived, or not that much.
   * No money moves — and that is the whole point. A rejection un-suppresses the
   * agent's late-deposit clock (their balance is no longer covered by an open
   * declaration) and leaves both sides' positions on the record for an admin.
   */
  async reject(params: {
    depositId: string;
    by: 'agency' | 'admin';
    agencyId?: string;
    reason: string;
    rejectedByUserId: string;
  }): Promise<IAgentDeposit> {
    const { depositId, by, agencyId, reason, rejectedByUserId } = params;

    const deposit = await this.loadDeclared(depositId, agencyId);
    this.assertConfirmer(deposit, by);

    const rejected = await AgentDepositModel.findOneAndUpdate(
      { _id: depositId, status: 'declared' },
      {
        $set: {
          status: 'rejected',
          rejection_reason: reason,
          recorded_by_user_id: new Types.ObjectId(rejectedByUserId),
          resolved_at: new Date(),
        },
      },
      { new: true }
    );
    if (!rejected) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_ALREADY_RESOLVED, 409);
    }

    await this.emit('cod.deposit.rejected', rejected);
    return rejected;
  }

  // ─── Direct recording (the receiving party was there) ───────────────────────

  /**
   * The receiving party records cash it has physically taken — declaration and
   * confirmation in one step, because it IS the counterparty and there is nobody
   * to counter-sign. This is the original agency flow and stays the common case:
   * an agent standing at the desk without the app in hand must still be able to
   * hand cash over.
   *
   * `recipient` lets an admin record a direct platform payment the same way.
   */
  async record(params: {
    agencyId: string;
    agentId: string;
    amount: number;
    recipient?: AgentDepositRecipient;
    reference?: string | null;
    note?: string | null;
    recordedByUserId: string;
  }): Promise<IAgentDeposit> {
    const { agencyId, agentId, amount, note, recordedByUserId } = params;
    const recipient = params.recipient ?? 'agency';

    const { currency, membership } = await this.assertDepositable({
      agentId,
      agencyId,
      amount,
      recipient,
    });

    let deposit: IAgentDeposit | null = null;
    await transactionManager.runInTransaction(async (session) => {
      const [created] = await AgentDepositModel.create(
        [
          {
            agent_id: agentId,
            agency_id: agencyId,
            amount,
            currency,
            note: note ?? null,
            recipient,
            status: 'confirmed',
            reference: params.reference?.trim() || null,
            declared_by_user_id: null,
            declared_at: null,
            recorded_by_user_id: recordedByUserId,
            resolved_at: new Date(),
          },
        ],
        { session }
      );
      deposit = created;
      await this.applyInSession(created, membership._id.toString(), session);
    });

    await this.emit('cod.deposit.recorded', deposit!);
    return deposit!;
  }

  // ─── The money movement ─────────────────────────────────────────────────────

  /**
   * Apply a confirmed deposit. Runs inside the caller's transaction.
   *
   * The agent leg always runs. The platform leg runs only for a direct payment,
   * and it is precisely what `AgencyRemittanceService.confirm` does — the agency
   * owed the platform this cash, and the platform now has it. Skipping it would
   * leave the agency liable for money the platform is holding, and the
   * collections it backs unsettled forever: nobody's earnings would release.
   */
  private async applyInSession(
    deposit: IAgentDeposit,
    membershipId: string,
    session: ClientSession
  ): Promise<void> {
    const depositId = deposit._id.toString();

    await this.cashAccounts.debitInSession(
      'agent',
      deposit.agent_id.toString(),
      deposit.amount,
      'deposit',
      'agent_deposit',
      depositId,
      session
    );

    // Guarded compare-and-set (balance >= amount), so a double-recorded handover
    // yields one settlement and one visible conflict — not a double draw-down
    // that frees headroom twice.
    const settled = await this.memberships.recordSettlement(membershipId, deposit.amount, session);
    if (!settled) {
      throw createAppError(ERROR_CODES.CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING, 409, undefined, {
        amount: deposit.amount,
        hint: 'The contract balance changed while this deposit was being recorded. Retry.',
      });
    }

    if (deposit.recipient !== 'platform') return;

    // Entry type 'remittance' against ref 'agent_deposit': in substance this IS
    // a remittance — the agency's liability falling because the cash reached the
    // platform — the evidence is just an agent's deposit rather than an agency's
    // transfer.
    await this.cashAccounts.debitInSession(
      'agency',
      deposit.agency_id.toString(),
      deposit.amount,
      'remittance',
      'agent_deposit',
      depositId,
      session
    );
    await this.settlement.applyFifoInSession(
      deposit.agency_id.toString(),
      deposit.amount,
      session
    );
  }

  // ─── Guards ─────────────────────────────────────────────────────────────────

  /**
   * Everything that must hold for `amount` to be depositable by this agent under
   * this contract, whoever is receiving it.
   */
  private async assertDepositable(params: {
    agentId: string;
    agencyId: string;
    amount: number;
    recipient: AgentDepositRecipient;
  }): Promise<{ currency: string; membership: any }> {
    const { agentId, agencyId, amount, recipient } = params;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_INVALID_AMOUNT, 422, undefined, { amount });
    }

    const agent = await this.agentRepo.findById(agentId);
    // A LIVE membership (not merely approved) is the right test: a suspended
    // agent must still be able to hand cash back — refusing their deposit is
    // exactly the wrong response to an agent you no longer trust.
    const membership = agent ? await this.memberships.findLive(agentId, agencyId) : null;
    if (!agent || !membership) {
      throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_NOT_FOUND, 404);
    }

    const { balance, currency } = await this.cashAccounts.getBalance('agent', agentId);
    if (amount > balance) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_EXCEEDS_BALANCE, 422, undefined, {
        amount,
        outstanding: balance,
      });
    }

    // The pot check above is not enough. That balance is the agent's cash across
    // EVERY agency, so it would happily let this agency book cash the agent is
    // actually holding for a rival — attributing a settlement to the wrong
    // contract, and freeing headroom the wrong contract never consumed. What may
    // be received is bounded by what THIS contract is owed.
    const outstandingHere = membership.cod?.outstanding_balance ?? 0;
    if (amount > outstandingHere) {
      throw createAppError(ERROR_CODES.CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING, 422, undefined, {
        amount,
        outstanding: outstandingHere,
        agentCashHeld: balance,
        hint:
          outstandingHere < balance
            ? 'The agent holds more cash than this contract accounts for; the remainder belongs to another agency.'
            : 'The agent does not owe this agency that much.',
      });
    }

    if (recipient === 'platform') {
      await this.assertPlatformIsStillOwed(agencyId, amount);
    }

    return { currency, membership };
  }

  /**
   * A direct payment is only meaningful while the platform is actually owed the
   * cash. If the agency has already remitted it — agencies are liable whether or
   * not their agent has paid up, so a diligent one may well front it — then the
   * platform is square and the agent's debt is genuinely to the AGENCY. Taking
   * the money here anyway would leave the platform holding it twice and owing
   * the agency a refund, which is not a thing this ledger models.
   *
   * So this bounds a direct deposit by the agency's live liability and sends the
   * agent back to the agency for the remainder. It is a correctness guard, not a
   * policy gate: it only ever fires when paying the platform would be wrong.
   */
  private async assertPlatformIsStillOwed(agencyId: string, amount: number): Promise<void> {
    const { balance: agencyOwes } = await this.cashAccounts.getBalance('agency', agencyId);
    if (amount > agencyOwes) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_AGENCY_ALREADY_SETTLED, 422, undefined, {
        amount,
        agencyOwesPlatform: agencyOwes,
        hint:
          agencyOwes === 0
            ? 'Your agency has already settled this cash with the platform — hand it to your agency instead.'
            : `The platform is only still owed ${agencyOwes} for this agency; pay that much directly and the rest to your agency.`,
      });
    }
  }

  private async loadDeclared(depositId: string, agencyId?: string): Promise<IAgentDeposit> {
    const deposit = Types.ObjectId.isValid(depositId)
      ? await AgentDepositModel.findById(depositId)
      : null;
    // Scope before status: an agency must never learn whether another agency's
    // deposit id exists.
    if (!deposit || (agencyId && deposit.agency_id.toString() !== agencyId)) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_NOT_FOUND, 404);
    }
    if (deposit.status !== 'declared') {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_ALREADY_RESOLVED, 409, undefined, {
        status: deposit.status,
      });
    }
    return deposit;
  }

  /** Only the party the cash was handed to may answer for it. */
  private assertConfirmer(deposit: IAgentDeposit, by: 'agency' | 'admin'): void {
    const expected = deposit.recipient === 'platform' ? 'admin' : 'agency';
    if (by !== expected) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_WRONG_RECIPIENT, 403, undefined, {
        recipient: deposit.recipient,
        hint: `This deposit was declared as paid to the ${deposit.recipient}; only ${expected === 'admin' ? 'the platform' : 'the agency'} can resolve it.`,
      });
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  /**
   * What this agent has declared and nobody has answered yet. The deadline sweep
   * uses the sum to suppress a late-deposit penalty the agent may not deserve.
   */
  async sumOpenDeclarationsForAgent(agentId: string): Promise<number> {
    const [result] = await AgentDepositModel.aggregate([
      { $match: { agent_id: new Types.ObjectId(agentId), status: 'declared' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  /**
   * The same sum, scoped to ONE contract.
   *
   * The late-deposit sweep needs this rather than the agent-global figure above:
   * it now evaluates each contract against that contract's own remittance
   * cadence, and a declaration made to agency A must not suppress a late flag
   * for cash owed to agency B. A deposit carries no contract id — it carries the
   * agent and the agency, which is the same thing, since a contract is exactly
   * that pair.
   */
  async sumOpenDeclarationsForContract(agentId: string, agencyId: string): Promise<number> {
    const [result] = await AgentDepositModel.aggregate([
      {
        $match: {
          agent_id: new Types.ObjectId(agentId),
          agency_id: new Types.ObjectId(agencyId),
          status: 'declared',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  async listForAgency(
    agencyId: string,
    page: number,
    limit: number,
    filter: { agentId?: string; status?: AgentDepositStatus } = {}
  ) {
    const query: Record<string, unknown> = { agency_id: agencyId };
    if (filter.agentId) query.agent_id = filter.agentId;
    if (filter.status) query.status = filter.status;
    return this.paginate(query, page, limit);
  }

  async listForAgent(agentId: string, page: number, limit: number, status?: AgentDepositStatus) {
    const query: Record<string, unknown> = { agent_id: agentId };
    if (status) query.status = status;
    return this.paginate(query, page, limit);
  }

  /**
   * The cash movements under ONE contract.
   *
   * A deposit carries no contract id — it carries the agent and the agency,
   * which is the same thing, since a contract is exactly that pair. Filtering on
   * both is therefore the per-contract history, and it stays correct if the pair
   * is ever re-contracted.
   */
  async listForContract(agentId: string, agencyId: string, page: number, limit: number) {
    return this.paginate({ agent_id: agentId, agency_id: agencyId }, page, limit);
  }

  /** The admin queue: platform-bound declarations waiting on a confirmation. */
  async listForAdmin(
    page: number,
    limit: number,
    filter: { status?: AgentDepositStatus; recipient?: AgentDepositRecipient; agencyId?: string } = {}
  ) {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.recipient) query.recipient = filter.recipient;
    if (filter.agencyId) query.agency_id = filter.agencyId;
    return this.paginate(query, page, limit);
  }

  private async paginate(filter: Record<string, unknown>, page: number, limit: number) {
    const [total, docs] = await Promise.all([
      AgentDepositModel.countDocuments(filter).exec(),
      AgentDepositModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    return {
      data: docs.map((d) => this.toDto(d)),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * `declaredAt` and `rejectionReason` are on the payload because the
   * notification handlers turn on them, and an event a subscriber has to re-read
   * the document to understand is not much of an event.
   *
   * `declaredAt` in particular is what separates the two very different things
   * `cod.deposit.recorded` can mean: null → the agency recorded a hand-over the
   * agent never declared (the agent is being TOLD about it, and that message is
   * the only way they will spot an under-recorded amount); non-null → the agency
   * answered a claim the agent had already made.
   */
  private async emit(
    eventType: 'cod.deposit.declared' | 'cod.deposit.recorded' | 'cod.deposit.rejected',
    deposit: IAgentDeposit
  ): Promise<void> {
    try {
      await eventBus.publish(eventType, {
        eventType,
        aggregateId: deposit._id.toString(),
        occurredAt: new Date(),
        payload: {
          depositId: deposit._id.toString(),
          agencyId: deposit.agency_id.toString(),
          agentId: deposit.agent_id.toString(),
          amount: deposit.amount,
          currency: deposit.currency,
          recipient: deposit.recipient,
          status: deposit.status,
          declaredAt: deposit.declared_at?.toISOString() ?? null,
          rejectionReason: deposit.rejection_reason ?? null,
        },
      });
    } catch (error) {
      console.error(`[AgentDepositService] Failed to emit ${eventType}:`, error);
    }
  }

  private toDto(deposit: IAgentDeposit) {
    return {
      id: deposit._id.toString(),
      agentId: deposit.agent_id.toString(),
      agencyId: deposit.agency_id.toString(),
      amount: deposit.amount,
      currency: deposit.currency,
      note: deposit.note,
      recipient: deposit.recipient,
      status: deposit.status,
      reference: deposit.reference,
      declaredAt: deposit.declared_at,
      resolvedAt: deposit.resolved_at,
      rejectionReason: deposit.rejection_reason,
      recordedAt: deposit.created_at,
    };
  }
}

export const agentDepositService = new AgentDepositService();
