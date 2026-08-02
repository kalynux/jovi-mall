import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { eventBus } from '../../../../core/events/event-bus';
import { PaginationOptions, Page } from '../../../../core/repositories/base.repository';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
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
  IContractFeeSplit,
  IContractRemittanceTerms,
  IContractCoverage,
  IMembershipEmployment,
} from '../../models/agent-agency-membership.model';
import { MembershipEventType } from '../../models/agent-membership-event.model';
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

/**
 * The negotiated terms an agency may patch. Every group is partial — the
 * repository dot-flattens each into `$set`, so an untouched key keeps its value.
 * `cod.threshold` is deliberately absent: it is bounded by the agent's shared
 * pool and must go through AgentCodThresholdService to be checked against it.
 */
export interface ContractTermsUpdate {
  employment?: Partial<IMembershipEmployment>;
  remittance_terms?: Partial<IContractRemittanceTerms>;
  coverage?: Partial<IContractCoverage>;
  fee_split?: Partial<IContractFeeSplit>;
  shipment_value_ceiling?: number | null;
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
 *  - withdraw — only the side that DID initiate it, and only while pending.
 *               Pulling back your own unanswered request needs nobody's
 *               agreement; it is `reject` seen from the other end.
 *
 * NOTE the authority matrix cannot express "whoever did not initiate", because
 * it is keyed on the party alone and the initiator is a property of the
 * CONTRACT. `approve`/`reject`/`withdraw` therefore read `unilateral` for both
 * parties here and are constrained separately by the initiator guard in
 * `requestTransition` — see `initiatorOf`. Both checks are required: the matrix
 * decides whether the action self-clears, the guard decides who may take it.
 */
const TRANSITION_AUTHORITY: Record<ContractTransition, Record<'agent' | 'agency', Authority>> = {
  approve: { agency: 'unilateral', agent: 'unilateral' },
  reject: { agency: 'unilateral', agent: 'unilateral' },
  withdraw: { agency: 'unilateral', agent: 'unilateral' },
  pause: { agency: 'unilateral', agent: 'requires_counterparty' },
  suspend: { agency: 'unilateral', agent: 'forbidden' },
  reactivate: { agency: 'unilateral', agent: 'requires_counterparty' },
  deactivate: { agency: 'requires_counterparty', agent: 'requires_counterparty' },
};

/** What each transition means in terms of status. */
const TRANSITION_TARGET: Record<ContractTransition, ContractStatus> = {
  approve: 'active',
  reject: 'rejected',
  withdraw: 'withdrawn',
  pause: 'paused',
  suspend: 'suspended',
  reactivate: 'active',
  deactivate: 'deactivated',
};

/** Legal `from` states for each transition. */
const TRANSITION_FROM: Record<ContractTransition, ContractStatus[]> = {
  approve: ['pending'],
  reject: ['pending'],
  withdraw: ['pending'],
  pause: ['active'],
  suspend: ['active', 'paused'],
  reactivate: ['paused', 'suspended'],
  deactivate: ['pending', 'active', 'paused', 'suspended'],
};

/**
 * Transitions whose permitted party depends on who raised the contract rather
 * than on the authority matrix. `true` = only the initiator may take it.
 */
const INITIATOR_SCOPED_TRANSITIONS: Partial<Record<ContractTransition, boolean>> = {
  approve: false,
  reject: false,
  withdraw: true,
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
    private readonly gates: AgentGateService = agentGateService,
    private readonly magazins: MagazinRepository = new MagazinRepository()
  ) {}

  // ─── Handshake notifications ──────────────────────────────────────────────

  /**
   * Tell the other party about a handshake event.
   *
   * Post-commit and fire-and-forget, per the module convention — a notification
   * must never fail the contract write that caused it. Both role stacks
   * subscribe to these event names and discriminate on `recipientRole`, the
   * same pattern the vendor↔agency `connection.*` events use.
   *
   * This is not optional polish. Until now the agency reached an agent by
   * email; with the directory there is nothing outside the platform carrying
   * the request, so an unnotified request is one nobody ever sees.
   */
  private notifyHandshake(
    situation: 'agent_contract.request_received' | 'agent_contract.approved' | 'agent_contract.rejected',
    contract: IAgentAgencyContract,
    recipientRole: 'agent' | 'agency'
  ): void {
    const contractId = contract._id.toString();
    const agentId = contract.agent_id.toString();
    const agencyId = contract.agency_id.toString();

    void (async () => {
      // Only the name the RECIPIENT needs is looked up — the agent is told who
      // the agency is, and vice versa.
      const [agent, agencyName] =
        recipientRole === 'agent'
          ? [null, await this.magazins.findNameByAgencyId(agencyId)]
          : [await this.agents.findById(agentId), null];

      await eventBus.publish(situation, {
        eventType: situation,
        aggregateId: contractId,
        occurredAt: new Date(),
        payload: {
          contractId,
          recipientRole,
          agentId,
          agencyId,
          agentName: agent?.name ?? '',
          agencyName: agencyName ?? '',
        },
      });
    })().catch((err) => console.error(`[AgentContractService] ${situation} emit failed:`, err));
  }

  // ─── Creation ─────────────────────────────────────────────────────────────

  /**
   * Agency asks a specific agent to contract → a pending contract the AGENT
   * approves.
   *
   * The mirror image of `requestToJoin`, and deliberately identical in shape:
   * the two creation paths differ only in who raised the request (`origin`) and
   * which stamp records it. Both land in `pending`; neither shortcuts to
   * `active`. The agency's request is its consent, the agent's approval is
   * theirs, and `resolveRequest` is the single place both are honoured.
   *
   * **Deliberately not blocked by threshold or relationship capacity**, for the
   * same reason as `requestToJoin` below — approval is what those bind.
   */
  async requestFromAgency(agencyId: string, agentId: string, actor: Actor): Promise<IAgentAgencyContract> {
    await this.gates.assertCanHoldContract(agentId);
    await this.assertNoLiveContract(agentId, agencyId);

    const contract = await transactionManager.runInTransaction(async (session) => {
      const contract = await this.contracts.create(
        {
          agentId,
          agencyId,
          status: 'pending',
          origin: 'invitation',
          invitedAt: new Date(),
          invitedByUserId: actor.userId,
        },
        session
      );

      await this.events.append(
        {
          membershipId: contract._id.toString(),
          agentId,
          agencyId,
          type: 'invited',
          fromStatus: null,
          toStatus: 'pending',
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
        session
      );

      return contract;
    });

    this.notifyHandshake('agent_contract.request_received', contract, 'agent');
    return contract;
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

    const contract = await transactionManager.runInTransaction(async (session) => {
      const created = await this.contracts.create(
        { agentId, agencyId, status: 'pending', origin: 'join_request', requestedAt: new Date() },
        session
      );

      await this.events.append(
        {
          membershipId: created._id.toString(),
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

      return created;
    });

    this.notifyHandshake('agent_contract.request_received', contract, 'agency');
    return contract;
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

    this.assertInitiatorRule(contract, transition, party);

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

      // Tell the party who RAISED the contract how it was answered. Only the
      // handshake pair — the lifecycle transitions (pause/suspend/deactivate)
      // have their own status-request inbox and are not notified here. Emitted
      // from this one place because both HTTP paths, agency and agent, funnel
      // through it.
      if ((transition === 'approve' || transition === 'reject') && applied.contract) {
        this.notifyHandshake(
          transition === 'approve' ? 'agent_contract.approved' : 'agent_contract.rejected',
          applied.contract,
          this.initiatorOf(contract)
        );
      }

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

  // ─── Status-request inbox ─────────────────────────────────────────────────

  /** Requests awaiting THIS agent's decision. */
  async listPendingRequestsForAgent(agentId: string): Promise<IContractStatusRequest[]> {
    return await this.requests.listPendingForAgent(agentId);
  }

  /** Requests awaiting THIS agency's decision. */
  async listPendingRequestsForAgency(agencyId: string): Promise<IContractStatusRequest[]> {
    return await this.requests.listPendingForAgency(agencyId);
  }

  /**
   * Resolve a request as one of the two parties.
   *
   * `resolveRequest` deliberately does not check who is resolving — it is also
   * the auto-approval path for unilateral transitions, where there is no
   * counterparty. That makes this wrapper the only safe entry point for a
   * request that arrived over HTTP: without the two checks below, the party who
   * RAISED a `requires_counterparty` request could approve it themselves, which
   * is precisely the consent the authority matrix exists to require.
   */
  async resolveRequestAs(
    party: 'agent' | 'agency',
    ownerId: string,
    requestId: string,
    decision: 'approve' | 'reject',
    actor: Actor,
    note: string | null = null
  ): Promise<{ request: IContractStatusRequest; contract: IAgentAgencyContract | null }> {
    const request = await this.requests.findById(requestId);
    if (!request) throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND, 404);

    // Scope: is this request even addressed to this agent/agency? A foreign
    // request 404s rather than 403s — the resolver should not learn it exists.
    const owner = party === 'agent' ? request.agent_id.toString() : request.agency_id.toString();
    if (owner !== ownerId) {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND, 404);
    }

    // Consent: the counterparty decides, never the requester.
    if (request.requested_by_role === party) {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_YOURS, 403, undefined, {
        requestedByRole: request.requested_by_role,
        hint: 'The other party must resolve a request you raised.',
      });
    }

    return await this.resolveRequest(requestId, decision, actor, { note });
  }

  /**
   * Raise a transition as the AGENT.
   *
   * The agent-side façade for `requestTransition`; the agency has one method per
   * transition because its set is fixed, whereas the agent's permitted set is
   * exactly what the authority matrix says is not `forbidden`, so the transition
   * is a parameter and the matrix does the refusing.
   */
  async requestTransitionAsAgent(
    agentId: string,
    contractId: string,
    transition: ContractTransition,
    actor: Actor,
    reason: string | null = null
  ): Promise<{ request: IContractStatusRequest; contract: IAgentAgencyContract | null }> {
    const contract = await this.contracts.findById(contractId);
    if (!contract || contract.agent_id.toString() !== agentId) {
      throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);
    }

    return await this.requestTransition(contractId, transition, 'agent', actor, { reason });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * One party's contracts, paginated, **every status by default** — see the note
   * on AgentContractRepository.listForAgent. These back the two "Connections"
   * views; nothing on the dispatch path reads them.
   */
  async listForAgent(
    agentId: string,
    filters: { status?: ContractStatus },
    pagination: PaginationOptions
  ): Promise<Page<IAgentAgencyContract>> {
    return await this.contracts.listForAgent(agentId, filters, pagination);
  }

  async listForAgency(
    agencyId: string,
    filters: { status?: ContractStatus },
    pagination: PaginationOptions
  ): Promise<Page<IAgentAgencyContract>> {
    return await this.contracts.listForAgency(agencyId, filters, pagination);
  }

  /** Admin only — the whole trail, unpaginated. See the repository's note. */
  async listAllForAgent(agentId: string): Promise<IAgentAgencyContract[]> {
    return await this.contracts.listAllForAgent(agentId);
  }

  async getForAgency(agencyId: string, contractId: string): Promise<IAgentAgencyContract> {
    return await this.loadForAgency(contractId, agencyId);
  }

  /**
   * The agent side of `getForAgency`. A contract belonging to someone else 404s
   * rather than 403s, for the same reason: the caller should not learn it exists.
   */
  async getForAgent(agentId: string, contractId: string): Promise<IAgentAgencyContract> {
    const contract = await this.contracts.findById(contractId);
    if (!contract || contract.agent_id.toString() !== agentId) {
      throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);
    }
    return contract;
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

  /**
   * Pull back a request this agency raised, before the agent has answered.
   *
   * Distinct from `declineRequest`: that refuses the agent's application, this
   * cancels the agency's own. The initiator guard in `requestTransition` is what
   * keeps the two from being interchangeable.
   */
  async withdrawRequest(
    agencyId: string,
    contractId: string,
    reason: string | null,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.loadForAgency(contractId, agencyId);
    const result = await this.requestTransition(contractId, 'withdraw', 'agency', actor, { reason });
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

  /** Update employment terms. Thin wrapper over `updateTerms`, kept for its route. */
  async updateEmployment(
    agencyId: string,
    contractId: string,
    employment: Record<string, unknown>,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    return await this.updateTerms(agencyId, contractId, { employment }, actor, 'employment_updated');
  }

  /**
   * Update the negotiated terms of a contract — everything except the COD
   * threshold, which is bounded by the agent's pool and so has its own path
   * through AgentCodThresholdService.
   *
   * `fee_split` is the load-bearing one: `EarningsQuoteService` divides by it at
   * both the offer estimate and the delivery split, so an incoherent split (a
   * percentage model carrying a flat fee, say) would not fail here but silently
   * mispay an agent at delivery. It is validated up front instead.
   */
  async updateTerms(
    agencyId: string,
    contractId: string,
    terms: ContractTermsUpdate,
    actor: Actor,
    eventType: MembershipEventType = 'terms_updated'
  ): Promise<IAgentAgencyContract> {
    const contract = await this.loadForAgency(contractId, agencyId);

    if (terms.fee_split) {
      this.assertFeeSplitCoherent(terms.fee_split, contract.fee_split);
    }

    const updated = await this.contracts.updateTerms(contractId, terms);
    if (!updated) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    await this.events.append({
      membershipId: contractId,
      agentId: contract.agent_id.toString(),
      agencyId,
      type: eventType,
      actorUserId: actor.userId,
      actorRole: actor.role,
      metadata: terms as Record<string, unknown>,
    });
    return updated;
  }

  /**
   * A fee split must carry exactly the field its model pays from.
   *
   * The incoming patch is merged over the stored split before checking, because
   * a partial update — switching `model` to 'flat' in one call having set
   * `agent_flat_fee` in a previous one — is legitimate and must not be rejected
   * for a field it is not changing.
   */
  private assertFeeSplitCoherent(
    patch: Partial<IContractFeeSplit>,
    current: IContractFeeSplit
  ): void {
    const next = { ...current, ...patch };

    if (next.model === 'percentage' && (next.agent_share_percent === null || next.agent_share_percent === undefined)) {
      throw createAppError(ERROR_CODES.CONTRACT_FEE_SPLIT_INVALID, 422, undefined, {
        model: next.model,
        hint: 'agent_share_percent is required when the fee split model is "percentage".',
      });
    }

    if (next.model === 'flat' && (next.agent_flat_fee === null || next.agent_flat_fee === undefined)) {
      throw createAppError(ERROR_CODES.CONTRACT_FEE_SPLIT_INVALID, 422, undefined, {
        model: next.model,
        hint: 'agent_flat_fee is required when the fee split model is "flat".',
      });
    }
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

  /**
   * Which party raised this contract.
   *
   * `origin` is the discriminator — the agent↔agency equivalent of
   * `requester_role` on the vendor↔agency connection. Only `join_request` is
   * agent-raised; `invitation` (an agency requesting a specific agent),
   * `transfer`, `admin` and `migration` are all agency- or platform-raised, and
   * in each of those the agent is the party who consents.
   */
  private initiatorOf(contract: IAgentAgencyContract): 'agent' | 'agency' {
    return contract.origin === 'join_request' ? 'agent' : 'agency';
  }

  /**
   * Enforce "the other side answers, your side withdraws" for the three
   * transitions whose permitted party depends on who raised the contract.
   *
   * Without this, `TRANSITION_AUTHORITY.approve` being `unilateral` for both
   * parties would let whoever raised a pending contract approve it themselves —
   * which is exactly the consent the handshake exists to obtain. It went
   * unnoticed until now only because the agent had no route to `approve`.
   */
  private assertInitiatorRule(
    contract: IAgentAgencyContract,
    transition: ContractTransition,
    party: 'agent' | 'agency'
  ): void {
    const initiatorOnly = INITIATOR_SCOPED_TRANSITIONS[transition];
    if (initiatorOnly === undefined) return;

    const initiator = this.initiatorOf(contract);
    if (initiatorOnly === (party === initiator)) return;

    throw createAppError(ERROR_CODES.CONTRACT_TRANSITION_NOT_PERMITTED, 403, undefined, {
      transition,
      party,
      initiator,
      hint: initiatorOnly
        ? 'Only the party that raised this request may withdraw it.'
        : 'The other party must respond to a request you raised.',
    });
  }

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
      case 'withdraw':
        return { withdrawn_at: now, withdrawal_reason: reason };
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
      withdraw: 'withdrawn',
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
