import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import {
  AgentMembershipEventRepository,
  agentMembershipEventRepository,
} from '../../repositories/agent-membership-event.repository';
import {
  ContractStatusRequestRepository,
  contractStatusRequestRepository,
} from '../../repositories/contract-status-request.repository';
import {
  IAgentAgencyContract,
  ContractStatus,
  ALLOCATING_CONTRACT_STATUSES,
} from '../../models/agent-agency-membership.model';
import {
  ContractTransition,
  ContractParty,
  IContractStatusRequest,
} from '../../models/contract-status-request.model';
import { AGENT_CONFIG } from '../../config/agent.config';
import { AgentCodThresholdService, agentCodThresholdService } from './agent-cod-threshold.service';
import { AgentGateService, agentGateService } from './agent-gate.service';

export interface Actor {
  userId: string | null;
  role: string;
}

/** Who may drive a transition without the counterparty's consent. */
type Authority = 'unilateral' | 'requires_counterparty' | 'forbidden';

/**
 * Authority matrix for contract transitions.
 *
 * §4 says every status change is a conditional action that can be approved or
 * rejected. Taken absolutely that produces absurdities — an agency suspending
 * an agent for cash shortfalls cannot need that agent's approval — so the
 * workflow is universal but the authority is not. Every transition raises a
 * ContractStatusRequest and lands in history; requests whose initiator holds
 * unilateral authority self-clear inside the same transaction.
 *
 * This matrix is a judgement call the spec did not settle, and it is stated
 * here rather than scattered through the service so it can be argued with:
 *
 *  - suspend  — the agency's disciplinary tool. Unilateral for the agency;
 *               forbidden to the agent (an agent "suspending" themselves is
 *               just going offline, which availability already expresses).
 *  - pause    — either side may want a breather. The agency pauses its own
 *               roster unilaterally; an agent's pause is a request, because it
 *               affects work the agency is relying on.
 *  - reactivate — mutual: whoever paused should not be overridden silently.
 *               Agency unilateral only if the agency paused it.
 *  - deactivate — always requires the counterparty, AND the §4 conditions.
 *               Ending a relationship is not one party's call.
 *  - approve/reject — only the side that did not initiate the contract.
 */
const TRANSITION_AUTHORITY: Record<ContractTransition, Record<'agent' | 'agency', Authority>> = {
  approve: { agency: 'unilateral', agent: 'unilateral' },
  reject: { agency: 'unilateral', agent: 'unilateral' },
  pause: { agency: 'unilateral', agent: 'requires_counterparty' },
  suspend: { agency: 'unilateral', agent: 'forbidden' },
  reactivate: { agency: 'unilateral', agent: 'requires_counterparty' },
  deactivate: { agency: 'requires_counterparty', agent: 'requires_counterparty' },
};

/** What each transition means in terms of status. */
const TRANSITION_TARGET: Record<ContractTransition, ContractStatus> = {
  approve: 'active',
  reject: 'rejected',
  pause: 'paused',
  suspend: 'suspended',
  reactivate: 'active',
  deactivate: 'deactivated',
};

/** Legal `from` states for each transition. */
const TRANSITION_FROM: Record<ContractTransition, ContractStatus[]> = {
  approve: ['pending'],
  reject: ['pending'],
  pause: ['active'],
  suspend: ['active', 'paused'],
  reactivate: ['paused', 'suspended'],
  deactivate: ['pending', 'active', 'paused', 'suspended'],
};

export interface DeactivationBlockers {
  outstandingCod: number;
  outstandingPayment: number;
  clear: boolean;
}

/**
 * AgentContractService — the agent↔agency contract lifecycle.
 *
 * Three invariants drive the guards here:
 *
 *  1. **The COD pool cannot be over-committed.** Approving a contract allocates
 *     its threshold out of the agent's global pool, so the allocation check runs
 *     inside the approval transaction. Outside it, two agencies approving at
 *     once would both read the same headroom and both commit.
 *
 *  2. **Termination must not strand cash or wages.** Deactivation is blocked
 *     while the agent holds this agency's COD, or the agency owes this agent
 *     money. Both scoped to the contract — leaving agency A is not blocked by
 *     cash owed to agency B. Once both are zero, termination is immediate:
 *     there is deliberately no notice period.
 *
 *  3. **Pausing does not free the pool.** A paused contract keeps its slice
 *     because the agent may still hold that agency's cash. Only termination
 *     (which requires zero) returns capacity.
 */
export class AgentContractService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly events: AgentMembershipEventRepository = agentMembershipEventRepository,
    private readonly requests: ContractStatusRequestRepository = contractStatusRequestRepository,
    private readonly thresholds: AgentCodThresholdService = agentCodThresholdService,
    private readonly gates: AgentGateService = agentGateService
  ) {}

  // ─── Creation ─────────────────────────────────────────────────────────────

  /**
   * Agent accepts an agency invitation → an active contract.
   *
   * The invite was the agency's consent and accepting is the agent's, so no
   * further approval step applies. The threshold check still runs: an agency
   * can invite an agent whose pool is full, and the contract simply cannot take
   * a non-zero slice until there is room.
   */
  async createFromAcceptedInvite(
    agentId: string,
    agencyId: string,
    invitedByUserId: string | null,
    invitedAt: Date | null,
    actor: Actor,
    codThreshold = 0
  ): Promise<IAgentAgencyContract> {
    await this.gates.assertCanHoldContract(agentId);
    await this.assertNoLiveContract(agentId, agencyId);

    return await transactionManager.runInTransaction(async (session) => {
      await this.assertRelationshipCapacity(agentId, session);
      if (codThreshold > 0) {
        await this.thresholds.assertContractThresholdAllowed(agentId, null, codThreshold, session);
      }

      const isFirst = (await this.contracts.countAllocatingForAgent(agentId, session)) === 0;

      const contract = await this.contracts.create(
        {
          agentId,
          agencyId,
          status: 'active',
          origin: 'invitation',
          isPrimary: isFirst,
          codThreshold,
          invitedByUserId,
          invitedAt,
          approvedAt: new Date(),
          approvedByUserId: invitedByUserId,
        },
        session
      );

      await this.events.append(
        {
          membershipId: contract._id.toString(),
          agentId,
          agencyId,
          type: 'invite_accepted',
          fromStatus: null,
          toStatus: 'active',
          actorUserId: actor.userId,
          actorRole: actor.role,
          metadata: { isPrimary: isFirst, codThreshold },
        },
        session
      );

      return contract;
    });
  }

  /**
   * Agent applies to an agency → a pending contract.
   *
   * **Deliberately not blocked by threshold capacity.** §1 is explicit: a
   * request may always be created even when the agent's pool is fully
   * allocated; it is APPROVAL that is blocked. Refusing the request would hide
   * the queue from the agency and give the agent nothing to point at when they
   * raise their threshold.
   */
  async requestToJoin(agentId: string, agencyId: string, actor: Actor): Promise<IAgentAgencyContract> {
    await this.gates.assertCanHoldContract(agentId);
    await this.assertNoLiveContract(agentId, agencyId);

    return await transactionManager.runInTransaction(async (session) => {
      const contract = await this.contracts.create(
        { agentId, agencyId, status: 'pending', origin: 'join_request', requestedAt: new Date() },
        session
      );

      await this.events.append(
        {
          membershipId: contract._id.toString(),
          agentId,
          agencyId,
          type: 'join_requested',
          fromStatus: null,
          toStatus: 'pending',
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
        session
      );

      return contract;
    });
  }

  // ─── The transition workflow ──────────────────────────────────────────────

  /**
   * Propose a transition. Auto-clears when the initiator holds unilateral
   * authority; otherwise leaves a pending request for the counterparty.
   */
  async requestTransition(
    contractId: string,
    transition: ContractTransition,
    party: 'agent' | 'agency',
    actor: Actor,
    options: { reason?: string | null; codThreshold?: number } = {}
  ): Promise<{ request: IContractStatusRequest; contract: IAgentAgencyContract | null }> {
    const contract = await this.contracts.findById(contractId);
    if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    const authority = TRANSITION_AUTHORITY[transition][party];
    if (authority === 'forbidden') {
      throw createAppError(ERROR_CODES.CONTRACT_TRANSITION_NOT_PERMITTED, 403, undefined, {
        transition,
        party,
      });
    }

    const legalFrom = TRANSITION_FROM[transition];
    if (!legalFrom.includes(contract.status)) {
      throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, undefined, {
        transition,
        from: contract.status,
        allowedFrom: legalFrom,
      });
    }

    const existing = await this.requests.findPending(contractId, transition);
    if (existing) {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_ALREADY_PENDING, 409, undefined, {
        requestId: existing._id.toString(),
      });
    }

    // Deactivation conditions are evaluated up front for the caller's benefit,
    // then RE-checked at approval — a request raised while clear must not be
    // approvable later if cash has since been collected.
    const blockers =
      transition === 'deactivate' ? await this.evaluateDeactivationBlockers(contract) : null;

    const request = await this.requests.create({
      contractId,
      agentId: contract.agent_id.toString(),
      agencyId: contract.agency_id.toString(),
      transition,
      targetStatus: TRANSITION_TARGET[transition],
      fromStatus: contract.status,
      requestedByRole: party as ContractParty,
      requestedByUserId: actor.userId,
      reason: options.reason ?? null,
      blockingConditions: blockers && !blockers.clear ? { ...blockers } : null,
    });

    if (authority === 'unilateral') {
      const applied = await this.resolveRequest(
        request._id.toString(),
        'approve',
        { userId: actor.userId, role: actor.role },
        { autoApproved: true, codThreshold: options.codThreshold }
      );
      return { request: applied.request, contract: applied.contract };
    }

    return { request, contract: null };
  }

  /**
   * Resolve a pending request. Every guard re-runs here — the request may have
   * sat for days, and the conditions that mattered are the ones true NOW.
   */
  async resolveRequest(
    requestId: string,
    decision: 'approve' | 'reject',
    actor: Actor,
    options: { autoApproved?: boolean; note?: string | null; codThreshold?: number } = {}
  ): Promise<{ request: IContractStatusRequest; contract: IAgentAgencyContract | null }> {
    return await transactionManager.runInTransaction(async (session) => {
      const request = await this.requests.findById(requestId, session);
      if (!request) throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND, 404);
      if (request.state !== 'pending') {
        throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_PENDING, 409, undefined, {
          state: request.state,
        });
      }

      const contract = await this.contracts.findById(request.contract_id.toString(), session);
      if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      if (decision === 'reject') {
        const rejected = await this.requests.resolve(
          requestId,
          'rejected',
          actor,
          options.note ?? null,
          session
        );
        return { request: rejected!, contract };
      }

      const transition = request.transition;
      const target = TRANSITION_TARGET[transition];
      const legalFrom = TRANSITION_FROM[transition];

      if (!legalFrom.includes(contract.status)) {
        throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, undefined, {
          transition,
          from: contract.status,
          allowedFrom: legalFrom,
        });
      }

      const agentId = contract.agent_id.toString();

      // ── Transition-specific guards ──────────────────────────────────────
      if (transition === 'approve') {
        // Platform gates first: KYC and bans outrank everything else. An
        // unverified agent must not be approvable regardless of headroom.
        await this.gates.assertCanHoldContract(agentId, session);
        await this.assertRelationshipCapacity(agentId, session);

        const threshold = options.codThreshold ?? contract.cod?.threshold ?? 0;
        if (threshold > 0) {
          // THE allocation check, inside the approval transaction.
          await this.thresholds.assertContractThresholdAllowed(agentId, contract._id.toString(), threshold, session);
        }
        if (options.codThreshold !== undefined) {
          await this.contracts.setCodThreshold(contract._id.toString(), threshold, session);
        }
      }

      if (transition === 'deactivate') {
        const blockers = await this.evaluateDeactivationBlockers(contract);
        if (!blockers.clear) {
          await this.requests.setBlockingConditions(requestId, { ...blockers }, session);
          if (blockers.outstandingCod > 0) {
            throw createAppError(ERROR_CODES.CONTRACT_HAS_OUTSTANDING_COD, 422, undefined, {
              outstandingCod: blockers.outstandingCod,
              hint: 'The agent must settle cash held under this contract before it can be deactivated.',
            });
          }
          throw createAppError(ERROR_CODES.CONTRACT_HAS_UNPAID_EARNINGS, 422, undefined, {
            outstandingPayment: blockers.outstandingPayment,
            hint: 'The agency must pay the agent for work under this contract before it can be deactivated.',
          });
        }
      }

      const stamps = this.stampsFor(transition, actor, request.reason);
      const updated = await this.contracts.transition(
        contract._id.toString(),
        legalFrom,
        target,
        stamps,
        session
      );
      if (!updated) {
        // Lost a race — someone else moved the contract between our read and write.
        throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, 'Contract changed concurrently');
      }

      const resolved = await this.requests.resolve(
        requestId,
        'approved',
        actor,
        options.note ?? null,
        session,
        options.autoApproved ?? false
      );

      await this.events.append(
        {
          membershipId: contract._id.toString(),
          agentId,
          agencyId: contract.agency_id.toString(),
          type: this.eventTypeFor(transition),
          fromStatus: contract.status,
          toStatus: target,
          actorUserId: actor.userId,
          actorRole: actor.role,
          reason: request.reason,
          metadata: { requestId, autoApproved: options.autoApproved ?? false },
        },
        session
      );

      // Deactivating the primary must not leave the agent without one.
      if (target === 'deactivated' && contract.is_primary) {
        await this.promoteNextPrimary(agentId, contract._id.toString(), session);
      }

      return { request: resolved!, contract: updated };
    });
  }

  /**
   * Why a contract cannot be terminated yet. Both conditions are contract-scoped
   * — §1's resolution replaced the old global COD block, so cash the agent owes
   * a different agency is none of this contract's business.
   */
  async evaluateDeactivationBlockers(contract: IAgentAgencyContract): Promise<DeactivationBlockers> {
    const outstandingCod = contract.cod?.outstanding_balance ?? 0;
    const outstandingPayment = contract.payment?.outstanding_to_agent ?? 0;
    return {
      outstandingCod,
      outstandingPayment,
      clear: outstandingCod === 0 && outstandingPayment === 0,
    };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async listForAgent(agentId: string, status?: ContractStatus): Promise<IAgentAgencyContract[]> {
    return await this.contracts.listForAgent(agentId, status);
  }

  async listForAgency(agencyId: string, status?: ContractStatus): Promise<IAgentAgencyContract[]> {
    return await this.contracts.listForAgency(agencyId, status);
  }

  async getForAgency(agencyId: string, contractId: string): Promise<IAgentAgencyContract> {
    return await this.loadForAgency(contractId, agencyId);
  }

  async requireActive(agentId: string, agencyId: string): Promise<IAgentAgencyContract> {
    const contract = await this.contracts.findActive(agentId, agencyId);
    if (!contract) {
      throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED, 422, undefined, { agentId, agencyId });
    }
    return contract;
  }

  async isActiveAt(agentId: string, agencyId: string): Promise<boolean> {
    return (await this.contracts.findActive(agentId, agencyId)) !== null;
  }

  // ─── Primary ──────────────────────────────────────────────────────────────

  async setPrimary(agentId: string, contractId: string, actor: Actor): Promise<IAgentAgencyContract> {
    const contract = await this.contracts.findById(contractId);
    if (!contract || contract.agent_id.toString() !== agentId) {
      throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);
    }
    if (contract.status !== 'active') {
      throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED, 409, undefined, {
        status: contract.status,
      });
    }

    return await transactionManager.runInTransaction(async (session) => {
      await this.contracts.clearPrimary(agentId, session);
      const updated = await this.contracts.setPrimary(contractId, session);
      if (!updated) throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED, 409);

      await this.events.append(
        {
          membershipId: contractId,
          agentId,
          agencyId: contract.agency_id.toString(),
          type: 'primary_changed',
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
        session
      );
      return updated;
    });
  }

  // ─── Agency-facing façade over the transition workflow ────────────────────
  //
  // Every one of these raises a ContractStatusRequest and routes it through
  // resolveRequest — they are not a second code path. They exist so callers
  // read as intent ("suspend this agent") rather than as workflow plumbing,
  // and so the authority matrix stays the single place that decides whether an
  // action self-clears or waits for the counterparty.

  /** Approve a pending join request → active. Allocates COD headroom. */
  async approve(
    agencyId: string,
    contractId: string,
    actor: Actor,
    codThreshold?: number
  ): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'approve', 'agency', actor, { codThreshold });
    return result.contract!;
  }

  async declineRequest(
    agencyId: string,
    contractId: string,
    reason: string | null,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'reject', 'agency', actor, { reason });
    return result.contract!;
  }

  /** Stops new assignments. Deliberately NOT gated by outstanding COD (§4). */
  async suspend(
    agencyId: string,
    contractId: string,
    reason: string | null,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'suspend', 'agency', actor, { reason });
    return result.contract!;
  }

  async pause(
    agencyId: string,
    contractId: string,
    reason: string | null,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'pause', 'agency', actor, { reason });
    return result.contract!;
  }

  async reinstate(agencyId: string, contractId: string, actor: Actor): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'reactivate', 'agency', actor, {});
    return result.contract!;
  }

  /**
   * Propose termination. Unlike suspend/pause this needs the counterparty AND
   * the §4 conditions, so it returns the REQUEST — the contract only moves once
   * cash is returned and the agent is paid. Callers must not assume a contract
   * comes back.
   */
  async requestDeactivation(
    agencyId: string,
    contractId: string,
    reason: string | null,
    actor: Actor
  ): Promise<{ request: IContractStatusRequest; contract: IAgentAgencyContract | null }> {
    await this.loadForAgency(contractId, agencyId);
    return await this.requestTransition(contractId, 'deactivate', 'agency', actor, { reason });
  }

  /** Update negotiated terms other than the COD threshold. */
  async updateEmployment(
    agencyId: string,
    contractId: string,
    employment: Record<string, unknown>,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    const contract = await this.loadForAgency(contractId, agencyId);
    const updated = await this.contracts.updateTerms(contractId, { employment });
    if (!updated) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    await this.events.append({
      membershipId: contractId,
      agentId: contract.agent_id.toString(),
      agencyId,
      type: 'employment_updated',
      actorUserId: actor.userId,
      actorRole: actor.role,
      metadata: { employment },
    });
    return updated;
  }

  // ─── Admin: transfer ──────────────────────────────────────────────────────

  /**
   * Move an agent from one agency to another. Admin-only — an agency must not
   * be able to pull an agent off a rival's roster.
   *
   * Deliberately NOT routed through requestTransition. Two reasons: the
   * authority matrix is written in terms of the two contract parties and a
   * transfer is neither party's call but the platform overriding both; and a
   * transfer is two contracts moving as one unit, which a single request cannot
   * describe.
   *
   * Order matters inside the transaction. The source is deactivated FIRST so
   * its slice returns to the pool before the target's threshold is checked
   * against headroom — check the target first and a straight move at an
   * unchanged threshold would need double the pool and always fail.
   *
   * The §4 termination gates still apply: a transfer must not strand cash the
   * agent holds for the source agency, nor wages that agency still owes. Being
   * admin-driven does not make the cash disappear.
   */
  async transfer(
    agentId: string,
    fromAgencyId: string,
    toAgencyId: string,
    reason: string | null,
    actor: Actor
  ): Promise<{ from: IAgentAgencyContract; to: IAgentAgencyContract }> {
    if (fromAgencyId === toAgencyId) {
      throw createAppError(
        ERROR_CODES.CONTRACT_INVALID_TRANSITION,
        422,
        'Source and target agency are the same'
      );
    }

    await this.gates.assertCanHoldContract(agentId);

    return await transactionManager.runInTransaction(async (session) => {
      const source = await this.contracts.findLive(agentId, fromAgencyId, session);
      if (!source) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      const existingAtTarget = await this.contracts.findLive(agentId, toAgencyId, session);
      if (existingAtTarget) {
        throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_ALREADY_EXISTS, 409, undefined, {
          status: existingAtTarget.status,
          contractId: existingAtTarget._id.toString(),
        });
      }

      const blockers = await this.evaluateDeactivationBlockers(source);
      if (!blockers.clear) {
        if (blockers.outstandingCod > 0) {
          throw createAppError(ERROR_CODES.CONTRACT_HAS_OUTSTANDING_COD, 422, undefined, {
            outstandingCod: blockers.outstandingCod,
            hint: 'The agent must settle cash held under the source contract before being transferred.',
          });
        }
        throw createAppError(ERROR_CODES.CONTRACT_HAS_UNPAID_EARNINGS, 422, undefined, {
          outstandingPayment: blockers.outstandingPayment,
          hint: 'The source agency must pay the agent for work under this contract before the transfer.',
        });
      }

      const threshold = source.cod?.threshold ?? 0;
      const wasPrimary = source.is_primary;
      const fromStatus = source.status;
      const now = new Date();

      const from = await this.contracts.transition(
        source._id.toString(),
        TRANSITION_FROM.deactivate,
        'deactivated',
        {
          deactivated_at: now,
          deactivated_by_user_id: actor.userId,
          deactivation_reason: reason,
          is_primary: false,
          transferred_to_agency_id: toAgencyId,
        },
        session
      );
      if (!from) {
        throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, 'Contract changed concurrently');
      }

      // The source's slice is free as of the write above, so the target's
      // threshold is checked against a pool that already reflects the release.
      if (threshold > 0) {
        await this.thresholds.assertContractThresholdAllowed(agentId, null, threshold, session);
      }

      const to = await this.contracts.create(
        {
          agentId,
          agencyId: toAgencyId,
          status: 'active',
          origin: 'transfer',
          // A transferred agent keeps their default-agency standing: losing it
          // silently would leave the agent with no primary at all.
          isPrimary: wasPrimary,
          codThreshold: threshold,
          approvedAt: now,
          approvedByUserId: actor.userId,
        },
        session
      );

      await this.events.append(
        {
          membershipId: source._id.toString(),
          agentId,
          agencyId: fromAgencyId,
          type: 'transferred_out',
          fromStatus,
          toStatus: 'deactivated',
          actorUserId: actor.userId,
          actorRole: actor.role,
          reason,
          metadata: { toAgencyId, threshold },
        },
        session
      );

      await this.events.append(
        {
          membershipId: to._id.toString(),
          agentId,
          agencyId: toAgencyId,
          type: 'transferred_in',
          fromStatus: null,
          toStatus: 'active',
          actorUserId: actor.userId,
          actorRole: actor.role,
          reason,
          metadata: { fromAgencyId, threshold, isPrimary: wasPrimary },
        },
        session
      );

      return { from, to };
    });
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  private async loadForAgency(contractId: string, agencyId: string): Promise<IAgentAgencyContract> {
    const contract = await this.contracts.findById(contractId);
    // A foreign contract reports 404, not 403 — an agency must not be able to
    // probe whether an agent works for a rival.
    if (!contract || contract.agency_id.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);
    }
    return contract;
  }

  private async assertNoLiveContract(agentId: string, agencyId: string): Promise<void> {
    const existing = await this.contracts.findLive(agentId, agencyId);
    if (existing) {
      throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_ALREADY_EXISTS, 409, undefined, {
        status: existing.status,
        contractId: existing._id.toString(),
      });
    }
  }

  private async assertRelationshipCapacity(agentId: string, session?: ClientSession): Promise<void> {
    const count = await this.contracts.countAllocatingForAgent(agentId, session);
    if (count >= AGENT_CONFIG.MAX_AGENCY_RELATIONSHIPS) {
      throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_LIMIT_REACHED, 422, undefined, {
        current: count,
        max: AGENT_CONFIG.MAX_AGENCY_RELATIONSHIPS,
      });
    }
  }

  private async promoteNextPrimary(
    agentId: string,
    excludeContractId: string,
    session: ClientSession
  ): Promise<void> {
    const remaining = (await this.contracts.listAllocating(agentId, session)).filter(
      (c) => c._id.toString() !== excludeContractId && c.status === 'active'
    );
    const next = remaining[0];
    if (!next) return;

    await this.contracts.setPrimary(next._id.toString(), session);
    await this.events.append(
      {
        membershipId: next._id.toString(),
        agentId,
        agencyId: next.agency_id.toString(),
        type: 'primary_changed',
        actorUserId: null,
        actorRole: 'system',
        reason: 'previous primary contract deactivated',
      },
      session
    );
  }

  private stampsFor(
    transition: ContractTransition,
    actor: Actor,
    reason: string | null
  ): Record<string, unknown> {
    const now = new Date();
    switch (transition) {
      case 'approve':
        return { approved_at: now, approved_by_user_id: actor.userId };
      case 'reject':
        return { rejected_at: now, rejection_reason: reason };
      case 'pause':
        return { paused_at: now, pause_reason: reason };
      case 'suspend':
        return { suspended_at: now, suspended_by_user_id: actor.userId, suspension_reason: reason };
      case 'reactivate':
        return {
          paused_at: null,
          pause_reason: null,
          suspended_at: null,
          suspended_by_user_id: null,
          suspension_reason: null,
        };
      case 'deactivate':
        return {
          deactivated_at: now,
          deactivated_by_user_id: actor.userId,
          deactivation_reason: reason,
          is_primary: false,
        };
    }
  }

  private eventTypeFor(transition: ContractTransition) {
    const map = {
      approve: 'approved',
      reject: 'request_declined',
      pause: 'paused',
      suspend: 'suspended',
      reactivate: 'reinstated',
      deactivate: 'removed',
    } as const;
    return map[transition];
  }
}

export const agentContractService = new AgentContractService();

/** Statuses that consume the agent's COD pool — re-exported for callers. */
export { ALLOCATING_CONTRACT_STATUSES };
