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
import { AgencyMagazinModel } from '../../magazin/models/magazin.model';

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
   *
   * The roster is the ALLOCATING set (active | paused | suspended), not merely
   * `active`: cash can legitimately be held under a paused/suspended contract
   * (collection and deposit both resolve via `findLive`), so an agent the agency
   * has suspended while they still sit on its cash must stay visible here — the
   * `liability` and `unsettledCollections` totals already count that cash, and a
   * per-agent breakdown that dropped them would understate who is holding what.
   *
   * **`cashHeld` is the CONTRACT's `cod.outstanding_balance`, never the agent's
   * `CodCashAccount` balance.** The cash account is one pot for the person across
   * every agency they serve; reading it here showed an agency money its agent
   * was holding for a rival, which is both a privacy leak and a number the
   * agency can act on wrongly — `AgentDepositService.assertDepositable` bounds a
   * deposit by the per-contract figure, so a desk chasing the pot figure gets a
   * 422 for cash that was never theirs. The two are equal only for an agent who
   * serves exactly one agency.
   */
  async agencySummary(agencyId: string) {
    const contracts = await this.memberships.listAllocatingForAgency(agencyId);

    const [liability, agents, unsettled] = await Promise.all([
      this.cashAccounts.getBalance('agency', agencyId),
      this.agentRepo.findManyByIds(contracts.map((c) => c.agent_id.toString())),
      this.unsettledCollections({ agency_id: new Types.ObjectId(agencyId) }),
    ]);

    const nameByAgentId = new Map(
      agents.map((a: IDeliveryAgent) => [a._id.toString(), a.name])
    );

    return {
      liability: {
        // What this agency still owes the platform (falls on confirmed remittances).
        balance: liability.balance,
        currency: liability.currency,
      },
      agents: contracts.map((contract) => {
        const agentId = contract.agent_id.toString();
        return {
          id: agentId,
          name: nameByAgentId.get(agentId) ?? null,
          // Cash this agent holds that is attributable to THIS agency.
          cashHeld: contract.cod?.outstanding_balance ?? 0,
        };
      }),
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
    // Business name lives on the Magazin (keyed by agency_id); contact fields on the agency.
    const [agencies, magazins] = await Promise.all([
      DeliveryAgencyModel.find({ _id: { $in: agencyIds } })
        .select('email phone status')
        .lean()
        .exec(),
      AgencyMagazinModel.find({ agency_id: { $in: agencyIds } })
        .select('agency_id name')
        .lean()
        .exec(),
    ]);
    const agencyById = new Map(agencies.map((a: any) => [a._id.toString(), a]));
    const nameByAgencyId = new Map(magazins.map((m: any) => [m.agency_id.toString(), m.name]));

    return {
      data: accounts.map((account) => {
        const agency: any = agencyById.get(account.owner_id.toString());
        return {
          agencyId: account.owner_id.toString(),
          agencyName: nameByAgencyId.get(account.owner_id.toString()) ?? null,
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
