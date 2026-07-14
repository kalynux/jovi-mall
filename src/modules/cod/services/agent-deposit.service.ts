import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { AgentDepositModel, IAgentDeposit } from '../models/agent-deposit.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { DeliveryAgentRepository } from '../../delivery/delivery-agent.repository';

/**
 * AgentDepositService - agency-side recording of cash physically received
 * from an agent. One transaction: deposit row + agent liability debit
 * (+ ledger). The agency's own liability to the platform is untouched — it
 * falls only when an admin confirms a remittance.
 */
export class AgentDepositService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly agentRepo: DeliveryAgentRepository = new DeliveryAgentRepository()
  ) {}

  async record(params: {
    agencyId: string;
    agentId: string;
    amount: number;
    note?: string | null;
    recordedByUserId: string;
  }): Promise<IAgentDeposit> {
    const { agencyId, agentId, amount, note, recordedByUserId } = params;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_INVALID_AMOUNT, 422, undefined, { amount });
    }

    const agent = await this.agentRepo.findById(agentId);
    if (!agent || agent.agency_id?.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOT_IN_AGENCY, 404);
    }

    const { balance, currency } = await this.cashAccounts.getBalance('agent', agentId);
    if (amount > balance) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_EXCEEDS_BALANCE, 422, undefined, {
        amount,
        outstanding: balance,
      });
    }

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
            recorded_by_user_id: recordedByUserId,
          },
        ],
        { session }
      );
      deposit = created;

      await this.cashAccounts.debitInSession(
        'agent',
        agentId,
        amount,
        'deposit',
        'agent_deposit',
        created._id.toString(),
        session
      );
    });

    try {
      await eventBus.publish('cod.deposit.recorded', {
        eventType: 'cod.deposit.recorded',
        aggregateId: deposit!._id.toString(),
        occurredAt: new Date(),
        payload: {
          depositId: deposit!._id.toString(),
          agencyId,
          agentId,
          amount,
          currency,
        },
      });
    } catch (error) {
      console.error('[AgentDepositService] Failed to emit cod.deposit.recorded:', error);
    }

    return deposit!;
  }

  async listForAgency(agencyId: string, page: number, limit: number, agentId?: string) {
    const filter: Record<string, unknown> = { agency_id: agencyId };
    if (agentId) filter.agent_id = agentId;
    return this.paginate(filter, page, limit);
  }

  async listForAgent(agentId: string, page: number, limit: number) {
    return this.paginate({ agent_id: agentId }, page, limit);
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

  private toDto(deposit: IAgentDeposit) {
    return {
      id: deposit._id.toString(),
      agentId: deposit.agent_id.toString(),
      agencyId: deposit.agency_id.toString(),
      amount: deposit.amount,
      currency: deposit.currency,
      note: deposit.note,
      recordedAt: deposit.created_at,
    };
  }
}

export const agentDepositService = new AgentDepositService();
