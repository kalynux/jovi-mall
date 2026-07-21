import { Types } from 'mongoose';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodCashAccountModel } from '../models/cod-cash-account.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import {
  AgentRepository,
  AgentMembershipRepository,
  DeliveryAgentModel,
  IDeliveryAgent,
} from '../../agents';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';

/**
 * CodSummaryService - read-only aggregate views of the COD cash chain:
 * the agency dashboard ("how much cash is out with my agents / what do I owe
 * the platform") and the admin overview (M7).
 */
export class CodSummaryService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly agentRepo: AgentRepository = new AgentRepository(),
    private readonly memberships: AgentMembershipRepository = new AgentMembershipRepository()
  ) {}

  /**
   * The agency's cash position: own liability, per-agent outstanding, unsettled
   * collections.
   *
   * The roster now comes from memberships rather than a foreign key on the
   * agent — the same agent may appear in several agencies' summaries, each
   * seeing only the cash they are exposed to.
   */
  async agencySummary(agencyId: string) {
    const agentIds = await this.memberships.listActiveAgentIds(agencyId);

    const [liability, agents, unsettled] = await Promise.all([
      this.cashAccounts.getBalance('agency', agencyId),
      this.agentRepo.findManyByIds(agentIds),
      this.unsettledCollections({ agency_id: new Types.ObjectId(agencyId) }),
    ]);

    const balances = await this.cashAccounts.getBalances(
      'agent',
      agents.map((a: IDeliveryAgent) => a._id.toString())
    );

    return {
      liability: {
        // What this agency still owes the platform (falls on confirmed remittances).
        balance: liability.balance,
        currency: liability.currency,
      },
      agents: agents.map((agent: IDeliveryAgent) => ({
        id: agent._id.toString(),
        name: agent.name,
        cashHeld: balances.get(agent._id.toString()) ?? 0,
      })),
      // Collected cash not yet covered by a confirmed remittance.
      unsettledCollections: unsettled,
    };
  }

  /** Platform-wide COD cash position (admin dashboard). */
  async adminOverview() {
    const [agentAccounts, agencyAccounts, unsettled] = await Promise.all([
      CodCashAccountModel.aggregate([
        { $match: { owner_type: 'agent' } },
        { $group: { _id: null, total: { $sum: '$balance' }, holders: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } } } },
      ]),
      CodCashAccountModel.aggregate([
        { $match: { owner_type: 'agency' } },
        { $group: { _id: null, total: { $sum: '$balance' }, debtors: { $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] } } } },
      ]),
      this.unsettledCollections({}),
    ]);

    return {
      cashHeldByAgents: {
        total: agentAccounts[0]?.total ?? 0,
        agentsHoldingCash: agentAccounts[0]?.holders ?? 0,
      },
      agencyLiabilities: {
        total: agencyAccounts[0]?.total ?? 0,
        agenciesOwing: agencyAccounts[0]?.debtors ?? 0,
      },
      unsettledCollections: unsettled,
    };
  }

  /** Agents holding COD cash, with trust context (admin oversight view). */
  async listAgentsForAdmin(page: number, limit: number) {
    const filter = { owner_type: 'agent' as const, balance: { $gt: 0 } };
    const [total, accounts] = await Promise.all([
      CodCashAccountModel.countDocuments(filter).exec(),
      CodCashAccountModel.find(filter)
        .sort({ balance: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    const agentIds = accounts.map((a) => a.owner_id.toString());
    const agents = await DeliveryAgentModel.find({ _id: { $in: agentIds } })
      .select('name email phone cod status')
      .lean()
      .exec();
    const agentById = new Map(agents.map((a: any) => [a._id.toString(), a]));

    // An agent may serve several agencies, so "which agency?" no longer has a
    // single answer — report every active one. The cash, by contrast, is one
    // pot: the figure that bounds it platform-wide is the agent's own COD pool,
    // read off the agent record already fetched above. Each contract's slice is
    // an allocation of that pool and binds only its agency, so no per-contract
    // figure belongs in this view.
    const agencyIdsByAgent = new Map<string, string[]>();
    await Promise.all(
      agentIds.map(async (id) => {
        agencyIdsByAgent.set(id, await this.memberships.listActiveAgencyIds(id));
      })
    );

    return {
      data: accounts.map((account) => {
        const id = account.owner_id.toString();
        const agent: any = agentById.get(id);
        return {
          agentId: id,
          name: agent?.name ?? null,
          email: agent?.email ?? null,
          phone: agent?.phone ?? null,
          agencyIds: agencyIdsByAgent.get(id) ?? [],
          status: agent?.status ?? null,
          cashHeld: account.balance,
          currency: account.currency,
          trustScore: agent?.cod?.trust_score ?? 100,
          codMaxThreshold: agent?.cod?.max_threshold ?? 0,
        };
      }),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /** Agencies owing the platform cash (admin oversight view). */
  async listAgenciesForAdmin(page: number, limit: number) {
    const filter = { owner_type: 'agency' as const, balance: { $gt: 0 } };
    const [total, accounts] = await Promise.all([
      CodCashAccountModel.countDocuments(filter).exec(),
      CodCashAccountModel.find(filter)
        .sort({ balance: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    const agencyIds = accounts.map((a) => a.owner_id);
    const agencies = await DeliveryAgencyModel.find({ _id: { $in: agencyIds } })
      .select('agency_name email phone status')
      .lean()
      .exec();
    const agencyById = new Map(agencies.map((a: any) => [a._id.toString(), a]));

    return {
      data: accounts.map((account) => {
        const agency: any = agencyById.get(account.owner_id.toString());
        return {
          agencyId: account.owner_id.toString(),
          agencyName: agency?.agency_name ?? null,
          email: agency?.email ?? null,
          phone: agency?.phone ?? null,
          status: agency?.status ?? null,
          liability: account.balance,
          currency: account.currency,
        };
      }),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /** Collected-but-not-fully-settled cash for a filter scope. */
  private async unsettledCollections(match: Record<string, unknown>) {
    const [result] = await CashCollectionModel.aggregate([
      { $match: { ...match, status: 'collected', $expr: { $lt: ['$settled_amount', '$expected_amount'] } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $subtract: ['$expected_amount', '$settled_amount'] } },
        },
      },
    ]);
    return { count: result?.count ?? 0, amount: result?.amount ?? 0 };
  }
}

export const codSummaryService = new CodSummaryService();
