import { ClientSession, Types } from 'mongoose';
import {
  AgentAgencyContractModel,
  IAgentAgencyContract,
  ContractStatus,
  ContractOrigin,
  ALLOCATING_CONTRACT_STATUSES,
  LIVE_CONTRACT_STATUSES,
  COUNTED_CONTRACT_STATUSES,
  IMembershipEmployment,
  IContractRemittanceTerms,
  IContractCoverage,
  IContractFeeSplit,
} from '../models/agent-agency-membership.model';

export interface CreateContractInput {
  agentId: string;
  agencyId: string;
  status: ContractStatus;
  origin: ContractOrigin;
  isPrimary?: boolean;
  codThreshold?: number;
  invitedByUserId?: string | null;
  invitedAt?: Date | null;
  requestedAt?: Date | null;
  approvedAt?: Date | null;
  approvedByUserId?: string | null;
}

/**
 * AgentContractRepository — persistence for agent↔agency contracts.
 *
 * Status transitions are guarded compare-and-set updates (`findOneAndUpdate`
 * filtered on the expected `from` status), never read-then-write. Two agency
 * admins clicking "approve" simultaneously must produce one approval and one
 * observable conflict, not two approvals that each allocate the same headroom.
 */
export class AgentContractRepository {
  async create(input: CreateContractInput, session?: ClientSession): Promise<IAgentAgencyContract> {
    const [contract] = await AgentAgencyContractModel.create(
      [
        {
          agent_id: input.agentId,
          agency_id: input.agencyId,
          status: input.status,
          origin: input.origin,
          is_primary: input.isPrimary ?? false,
          cod: {
            threshold: input.codThreshold ?? 0,
            outstanding_balance: 0,
            lifetime_settled: 0,
            last_settled_at: null,
          },
          invited_by_user_id: input.invitedByUserId ?? null,
          invited_at: input.invitedAt ?? null,
          requested_at: input.requestedAt ?? null,
          approved_at: input.approvedAt ?? null,
          approved_by_user_id: input.approvedByUserId ?? null,
        },
      ],
      session ? { session } : {}
    );
    return contract;
  }

  async findById(contractId: string, session?: ClientSession): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findById(contractId).session(session ?? null);
  }

  /** The live (non-terminal) contract between an agent and an agency, if any. */
  async findLive(
    agentId: string,
    agencyId: string,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOne({
      agent_id: agentId,
      agency_id: agencyId,
      status: { $in: LIVE_CONTRACT_STATUSES },
    }).session(session ?? null);
  }

  async findActive(
    agentId: string,
    agencyId: string,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOne({
      agent_id: agentId,
      agency_id: agencyId,
      status: 'active',
    }).session(session ?? null);
  }

  /**
   * Contracts consuming the agent's COD pool. THE query behind the allocation
   * constraint — always run it with the caller's session so the sum it produces
   * is transactionally consistent with the write that depends on it.
   */
  async listAllocating(agentId: string, session?: ClientSession): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({
      agent_id: agentId,
      status: { $in: ALLOCATING_CONTRACT_STATUSES },
    }).session(session ?? null);
  }

  async listForAgent(agentId: string, status?: ContractStatus): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({
      agent_id: agentId,
      status: status ? status : { $in: LIVE_CONTRACT_STATUSES },
    }).sort({ created_at: -1 });
  }

  async listAllForAgent(agentId: string): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({ agent_id: agentId }).sort({ created_at: -1 });
  }

  async listForAgency(agencyId: string, status?: ContractStatus): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({
      agency_id: agencyId,
      status: status ? status : { $in: LIVE_CONTRACT_STATUSES },
    }).sort({ created_at: -1 });
  }

  /** Contracts counting toward the agent's max-relationships cap. */
  async countAllocatingForAgent(agentId: string, session?: ClientSession): Promise<number> {
    return await AgentAgencyContractModel.countDocuments({
      agent_id: agentId,
      status: { $in: COUNTED_CONTRACT_STATUSES },
    }).session(session ?? null);
  }

  async listActiveAgencyIds(agentId: string): Promise<string[]> {
    const rows = await AgentAgencyContractModel.find({ agent_id: agentId, status: 'active' }, { agency_id: 1 });
    return rows.map((r) => r.agency_id.toString());
  }

  async listActiveAgentIds(agencyId: string): Promise<string[]> {
    const rows = await AgentAgencyContractModel.find({ agency_id: agencyId, status: 'active' }, { agent_id: 1 });
    return rows.map((r) => r.agent_id.toString());
  }

  // ─── Guarded transitions ──────────────────────────────────────────────────

  /**
   * Compare-and-set a status transition. Returns null when the contract was not
   * in `from` — i.e. someone moved it first. Callers must treat null as a
   * conflict, never as "not found".
   */
  async transition(
    contractId: string,
    from: ContractStatus | ContractStatus[],
    to: ContractStatus,
    stamps: Record<string, unknown> = {},
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    const fromList = Array.isArray(from) ? from : [from];
    return await AgentAgencyContractModel.findOneAndUpdate(
      { _id: contractId, status: { $in: fromList } },
      { $set: { status: to, ...stamps } },
      { new: true, session }
    );
  }

  async setCodThreshold(
    contractId: string,
    threshold: number,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findByIdAndUpdate(
      contractId,
      { $set: { 'cod.threshold': threshold } },
      { new: true, session }
    );
  }

  /**
   * Move the outstanding COD balance. `delta` is signed: positive when the
   * agent collects cash, negative when they settle it.
   *
   * Guarded so the balance can never go negative: the filter requires the
   * current balance to be at least the amount being removed. A settlement racing
   * another settlement therefore fails visibly instead of driving the balance
   * below zero and silently freeing headroom that was never returned.
   */
  async adjustOutstandingBalance(
    contractId: string,
    delta: number,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    const filter: Record<string, unknown> = { _id: contractId };
    if (delta < 0) filter['cod.outstanding_balance'] = { $gte: Math.abs(delta) };

    return await AgentAgencyContractModel.findOneAndUpdate(
      filter,
      { $inc: { 'cod.outstanding_balance': delta } },
      { new: true, session }
    );
  }

  async recordSettlement(
    contractId: string,
    amount: number,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOneAndUpdate(
      { _id: contractId, 'cod.outstanding_balance': { $gte: amount } },
      {
        $inc: { 'cod.outstanding_balance': -amount, 'cod.lifetime_settled': amount },
        $set: { 'cod.last_settled_at': new Date() },
      },
      { new: true, session }
    );
  }

  async adjustOutstandingPayment(
    contractId: string,
    delta: number,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    const filter: Record<string, unknown> = { _id: contractId };
    if (delta < 0) filter['payment.outstanding_to_agent'] = { $gte: Math.abs(delta) };

    return await AgentAgencyContractModel.findOneAndUpdate(
      filter,
      { $inc: { 'payment.outstanding_to_agent': delta } },
      { new: true, session }
    );
  }

  async recordAgentPayment(
    contractId: string,
    amount: number,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOneAndUpdate(
      { _id: contractId, 'payment.outstanding_to_agent': { $gte: amount } },
      {
        $inc: { 'payment.outstanding_to_agent': -amount, 'payment.lifetime_paid': amount },
        $set: { 'payment.last_paid_at': new Date() },
      },
      { new: true, session }
    );
  }

  // ─── Terms ────────────────────────────────────────────────────────────────

  async updateTerms(
    contractId: string,
    terms: {
      employment?: Partial<IMembershipEmployment>;
      remittance_terms?: Partial<IContractRemittanceTerms>;
      coverage?: Partial<IContractCoverage>;
      fee_split?: Partial<IContractFeeSplit>;
      shipment_value_ceiling?: number | null;
    },
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    const set: Record<string, unknown> = {};
    for (const [group, value] of Object.entries(terms)) {
      if (value === undefined) continue;
      if (group === 'shipment_value_ceiling') {
        set[group] = value;
        continue;
      }
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (inner !== undefined) set[`${group}.${key}`] = inner;
      }
    }
    if (Object.keys(set).length === 0) return await this.findById(contractId, session);

    return await AgentAgencyContractModel.findByIdAndUpdate(contractId, { $set: set }, { new: true, session });
  }

  // ─── Primary agency ───────────────────────────────────────────────────────

  async clearPrimary(agentId: string, session?: ClientSession): Promise<void> {
    await AgentAgencyContractModel.updateMany(
      { agent_id: agentId, is_primary: true, status: { $in: ALLOCATING_CONTRACT_STATUSES } },
      { $set: { is_primary: false } },
      { session }
    );
  }

  async setPrimary(contractId: string, session?: ClientSession): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOneAndUpdate(
      { _id: contractId, status: 'active' },
      { $set: { is_primary: true } },
      { new: true, session }
    );
  }

  async findPrimary(agentId: string): Promise<IAgentAgencyContract | null> {
    return await AgentAgencyContractModel.findOne({
      agent_id: agentId,
      is_primary: true,
      status: { $in: ALLOCATING_CONTRACT_STATUSES },
    });
  }

  /** Agent ids with an active contract in the given agencies. */
  async listAgentIdsForAgencies(agencyIds: string[]): Promise<string[]> {
    if (agencyIds.length === 0) return [];
    const rows = await AgentAgencyContractModel.find(
      { agency_id: { $in: agencyIds.map((id) => new Types.ObjectId(id)) }, status: 'active' },
      { agent_id: 1 }
    );
    return [...new Set(rows.map((r) => r.agent_id.toString()))];
  }

  /** Every agent with at least one allocating contract — the trust recompute set. */
  async listAgentIdsWithContracts(): Promise<string[]> {
    const ids = await AgentAgencyContractModel.distinct('agent_id', {
      status: { $in: ALLOCATING_CONTRACT_STATUSES },
    });
    return ids.map((id) => id.toString());
  }
}

export const agentContractRepository = new AgentContractRepository();

/**
 * Backwards-compatible aliases — COD and shipments still speak "membership".
 * Declared as both a value and a type so `new AgentMembershipRepository()` and
 * `x: AgentMembershipRepository` both resolve; a bare `const` alias only carries
 * the value and breaks every type annotation.
 */
export const AgentMembershipRepository = AgentContractRepository;
export type AgentMembershipRepository = AgentContractRepository;
export const agentMembershipRepository = agentContractRepository;
