import { ClientSession, FilterQuery, Types } from 'mongoose';
import { PaginationOptions, Page } from '../../../core/repositories/base.repository';
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
  ContractTermsParty,
} from '../models/agent-agency-membership.model';

/** The negotiated groups a caller may write. Mirrors ContractTermsUpdate. */
export interface ContractTermsPatch {
  employment?: Partial<IMembershipEmployment>;
  remittance_terms?: Partial<IContractRemittanceTerms>;
  coverage?: Partial<IContractCoverage>;
  fee_split?: Partial<IContractFeeSplit>;
  shipment_value_ceiling?: number | null;
}

export interface CreateContractInput {
  agentId: string;
  agencyId: string;
  status: ContractStatus;
  origin: ContractOrigin;
  isPrimary?: boolean;
  codThreshold?: number;
  /** Terms stated by the requesting party, written in the same insert. */
  terms?: ContractTermsPatch;
  /** Which party stated them. null = none stated, which is not approvable. */
  termsProposedBy?: ContractTermsParty | null;
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
    // Only the groups the caller actually stated are spread in, so the rest fall
    // to the schema defaults rather than being written as explicit undefined.
    const terms = input.terms ?? {};
    const statedGroups: Record<string, unknown> = {};
    for (const [group, value] of Object.entries(terms)) {
      if (value !== undefined) statedGroups[group] = value;
    }

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
          ...statedGroups,
          terms_proposed_by: input.termsProposedBy ?? null,
          terms_version: input.termsProposedBy ? 1 : 0,
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

  /**
   * One party's contracts, paginated.
   *
   * **No `status` means every status, terminal rows included** — the same rule as
   * ConnectionRepository.listForVendor. These back the "Connections" views, and a
   * relationship history that silently omits the rejected/withdrawn/deactivated
   * rows is not a history. Callers that want only live contracts pass a status,
   * or use the purpose-built `findLive`/`findActive`/`listAllocating` above,
   * which is what every dispatch-path caller already does.
   */
  async listForAgent(
    agentId: string,
    filters: { status?: ContractStatus },
    pagination: PaginationOptions
  ): Promise<Page<IAgentAgencyContract>> {
    return await this.paginateBy({ agent_id: agentId }, filters, pagination);
  }

  async listForAgency(
    agencyId: string,
    filters: { status?: ContractStatus },
    pagination: PaginationOptions
  ): Promise<Page<IAgentAgencyContract>> {
    return await this.paginateBy({ agency_id: agencyId }, filters, pagination);
  }

  /**
   * Every contract an agent has ever held, unpaginated.
   *
   * Exists for the admin agent view, which is explicitly "the profile plus every
   * membership" and must not silently truncate at a page boundary. Deliberately
   * not exposed to the agent or agency — they get `listForAgent`/`listForAgency`,
   * which page.
   */
  async listAllForAgent(agentId: string): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({ agent_id: agentId }).sort({ updated_at: -1 });
  }

  private async paginateBy(
    scope: FilterQuery<IAgentAgencyContract>,
    filters: { status?: ContractStatus },
    pagination: PaginationOptions
  ): Promise<Page<IAgentAgencyContract>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IAgentAgencyContract> = { ...scope };
    if (filters.status) filter.status = filters.status;

    const [total, docs] = await Promise.all([
      AgentAgencyContractModel.countDocuments(filter).exec(),
      AgentAgencyContractModel.find(filter)
        .sort({ updated_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
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

  /**
   * This agency's contracts that can still be holding its cash — the ALLOCATING
   * set (active | paused | suspended), not merely `active`.
   *
   * Cash legitimately lands on and stays under a paused/suspended contract: a
   * collection attributes via `findLive` and a deposit is accepted via
   * `findLive`, both of which span the allocating set. The agency COD summary
   * must therefore draw its per-agent breakdown from here, or a suspended agent
   * still sitting on the agency's cash would vanish from the list while the
   * agency's liability total still counted it.
   *
   * Returns the contract documents rather than bare agent ids, deliberately:
   * the only thing an agency may be shown about an agent's cash is
   * `cod.outstanding_balance` — the slice attributable to THIS contract. Handing
   * back ids invites the caller to look the agent up in `CodCashAccount`, which
   * is the person's pot across every agency and is not this agency's business.
   */
  async listAllocatingForAgency(agencyId: string): Promise<IAgentAgencyContract[]> {
    return await AgentAgencyContractModel.find({
      agency_id: agencyId,
      status: { $in: ALLOCATING_CONTRACT_STATUSES },
    });
  }

  // ─── Directory annotation ─────────────────────────────────────────────────
  //
  // Both browse endpoints left-join the caller's contracts onto a page of
  // counterparties so the UI can render Request / Pending / Connected states.
  // Scoped to the PAGE's ids rather than fetching the caller's whole contract
  // set — the vendor↔agency equivalent (ConnectionRepository.findAllForEntity)
  // pulls every row unpaginated, which is a wart worth not reproducing.
  //
  // Every status is returned, terminal rows included: unlike the vendor model's
  // one-document-per-pair, a pair here accumulates a row per contract, so the
  // caller picks the live one and falls back to the most recent terminal one.
  // Sorted newest-first so that fallback is just "the first match".

  async findForAgencyAndAgents(
    agencyId: string,
    agentIds: string[]
  ): Promise<IAgentAgencyContract[]> {
    if (agentIds.length === 0) return [];
    return await AgentAgencyContractModel.find({
      agency_id: agencyId,
      agent_id: { $in: agentIds.map((id) => new Types.ObjectId(id)) },
    }).sort({ created_at: -1 });
  }

  async findForAgentAndAgencies(
    agentId: string,
    agencyIds: string[]
  ): Promise<IAgentAgencyContract[]> {
    if (agencyIds.length === 0) return [];
    return await AgentAgencyContractModel.find({
      agent_id: agentId,
      agency_id: { $in: agencyIds.map((id) => new Types.ObjectId(id)) },
    }).sort({ created_at: -1 });
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

  /**
   * Patch the negotiated terms.
   *
   * Each group is dot-flattened into `$set` so an untouched key inside a group
   * keeps its stored value — a caller changing only `fee_split.model` must not
   * blank `agent_flat_fee`.
   *
   * `meta` carries the negotiation state. Supplying it makes this a PROPOSAL
   * (the terms now stand in the named party's name and the version advances);
   * omitting it makes it a silent correction. The service supplies it on every
   * counter and on every accepted proposal, and omits it nowhere — it is
   * optional only so that `applyAgreedTerms` can express "keep the proposer,
   * bump the version".
   */
  async updateTerms(
    contractId: string,
    terms: ContractTermsPatch,
    session?: ClientSession,
    meta?: { termsProposedBy?: ContractTermsParty | null; bumpVersion?: boolean }
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

    if (meta && meta.termsProposedBy !== undefined) set.terms_proposed_by = meta.termsProposedBy;
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (meta?.bumpVersion) update.$inc = { terms_version: 1 };

    if (Object.keys(update).length === 0) return await this.findById(contractId, session);

    return await AgentAgencyContractModel.findByIdAndUpdate(contractId, update, { new: true, session });
  }

  /**
   * Apply an accepted proposal's terms to the contract.
   *
   * Distinct from `updateTerms` only in intent, and named so the accept path
   * reads as what it is. `terms_proposed_by` becomes the party whose proposal
   * won, because they are the party whose terms now stand.
   */
  async applyAgreedTerms(
    contractId: string,
    terms: ContractTermsPatch,
    acceptedFrom: ContractTermsParty,
    session?: ClientSession
  ): Promise<IAgentAgencyContract | null> {
    return await this.updateTerms(contractId, terms, session, {
      termsProposedBy: acceptedFrom,
      bumpVersion: true,
    });
  }

  /**
   * Active contracts for a set of agents at one agency, in ONE query.
   *
   * The dispatch path needs each candidate's contract to read its coverage,
   * value ceiling and COD threshold. Fetching them per agent is an N+1 across
   * the whole eligible pool on every auto-assignment; this is the batched form
   * every caller there should use.
   */
  async listActiveForAgencyAndAgents(
    agencyId: string,
    agentIds: string[]
  ): Promise<IAgentAgencyContract[]> {
    if (agentIds.length === 0) return [];
    return await AgentAgencyContractModel.find({
      agency_id: agencyId,
      agent_id: { $in: agentIds.map((id) => new Types.ObjectId(id)) },
      status: 'active',
    });
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
