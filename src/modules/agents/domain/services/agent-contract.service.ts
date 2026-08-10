import { ClientSession } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { eventBus } from '../../../../core/events/event-bus';
import { PaginationOptions, Page } from '../../../../core/repositories/base.repository';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
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
  ContractTermsProposalRepository,
  contractTermsProposalRepository,
} from '../../repositories/contract-terms-proposal.repository';
import {
  IAgentAgencyContract,
  ContractStatus,
  ALLOCATING_CONTRACT_STATUSES,
  IContractFeeSplit,
  IContractRemittanceTerms,
  IContractCoverage,
  IMembershipEmployment,
  ContractTermsParty,
  NEGOTIABLE_TERM_GROUPS,
  AGENT_NEGOTIABLE_TERM_GROUPS,
  contractDefaults,
} from '../../models/agent-agency-membership.model';
import {
  IContractTermsProposal,
  ProposedTerms,
} from '../../models/contract-terms-proposal.model';
import { MembershipEventType } from '../../models/agent-membership-event.model';
import {
  ContractTransition,
  ContractParty,
  IContractStatusRequest,
} from '../../models/contract-status-request.model';
import { AGENT_CONFIG } from '../../config/agent.config';
import { AgentCodThresholdService, agentCodThresholdService } from './agent-cod-threshold.service';
import { AgentGateService, agentGateService } from './agent-gate.service';
import { normalizeContractRegions } from './contract-coverage.service';

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
 * NOTE the authority matrix cannot express "whoever did not propose", because
 * it is keyed on the party alone and the proposer is a property of the
 * CONTRACT. `approve`/`reject`/`withdraw` therefore read `unilateral` for both
 * parties here and are constrained separately by the proposer guard in
 * `requestTransition` — see `proposerOf`. Both checks are required: the matrix
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
 * Transitions whose permitted party depends on who made the STANDING PROPOSAL
 * rather than on the authority matrix. `true` = only the proposer may take it.
 *
 * All three are keyed on the proposer, not on who raised the contract, and
 * `withdraw` being here is the load-bearing part. Suppose it were keyed on
 * `origin` instead, and an agency invites an agent who counters:
 *
 *   - the agency is the origin-initiator (may `withdraw`) AND the counterparty
 *     of the proposer (may `reject`) — two ways out;
 *   - the agent is the proposer, so may not `approve`/`reject` their own
 *     proposal, and is not the initiator, so may not `withdraw` — NO way out.
 *
 * The agent would be trapped inside their own counter-offer. Scoping all three
 * to the proposer makes the algebra total and symmetric at every step of a
 * negotiation, however long: the proposer withdraws, the counterparty answers.
 */
const PROPOSER_SCOPED_TRANSITIONS: Partial<Record<ContractTransition, boolean>> = {
  approve: false,
  reject: false,
  withdraw: true,
};

/**
 * A Mongoose sub-document as inert data.
 *
 * The term-group interfaces are plain TS types and do not declare `toObject`,
 * but at runtime these are Mongoose sub-documents that do have it. Copying one
 * by reference would hand out a live object that follows the parent as it
 * changes — wrong for a snapshot, and wrong for terms being carried onto a
 * different contract.
 */
function plainOf<T>(value: T | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined;
  const maybeDoc = value as unknown as { toObject?: () => T };
  return typeof maybeDoc.toObject === 'function' ? maybeDoc.toObject() : value;
}

/**
 * Every negotiated term on a contract, as an inert patch.
 *
 * Exported and pure so the DB-free harness can cover it: its one caller
 * (`transfer`) runs inside a transaction and is therefore unreachable without
 * Mongo, but the thing that actually matters — that no group is silently
 * dropped — is checkable here.
 *
 * Dropping one is not a neutral default. A transfer lands the destination
 * contract `active`, so it never passes through `approve` and
 * `assertTermsApprovable` cannot catch a split that pays nothing; an agent
 * whose `fee_split` failed to carry would arrive on
 * `contractDefaults.feeSplit()` — a null share, i.e. a cut of ZERO — and work
 * for free until somebody noticed.
 */
export function contractTermsOf(contract: IAgentAgencyContract): ContractTermsUpdate {
  return {
    employment: plainOf(contract.employment),
    remittance_terms: plainOf(contract.remittance_terms),
    coverage: plainOf(contract.coverage),
    fee_split: plainOf(contract.fee_split),
    shipment_value_ceiling: contract.shipment_value_ceiling,
  };
}

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
    private readonly proposals: ContractTermsProposalRepository = contractTermsProposalRepository,
    private readonly thresholds: AgentCodThresholdService = agentCodThresholdService,
    private readonly gates: AgentGateService = agentGateService,
    private readonly magazins: MagazinRepository = new MagazinRepository(),
    // Only for the agency's `country`, which anchors the coverage-region
    // catalogue both parties pick from. The business surface (name, coverage
    // areas) is the magazin's — see `normalizeCoverageTerms`.
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()
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
    situation:
      | 'agent_contract.request_received'
      | 'agent_contract.approved'
      | 'agent_contract.rejected'
      | 'agent_contract.terms_countered',
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

  /**
   * Tell the other party about a pending contract CHANGE, or about its answer.
   *
   * Separate from `notifyHandshake` above because the two describe different
   * things: that one is the handshake that forms a contract, this one is a
   * transition on a contract that already exists. They were silent until now on
   * the reasoning that such transitions have their own status-request inbox —
   * but an inbox nobody is told about is one that gets read when someone
   * happens to open the tab, which for a proposed termination is too late to be
   * useful.
   *
   * Emitted only for transitions that actually stay pending. A `unilateral`
   * transition self-clears inside `requestTransition` and never waits on anyone,
   * so announcing it as "needs your answer" would be a lie; that is also why the
   * resolution half is emitted from `resolveRequestAs`/`cancelRequestAs` — the
   * two HTTP entry points — rather than from `resolveRequest`, which is shared
   * with the auto-approval path.
   *
   * Post-commit and fire-and-forget, per the module convention.
   */
  private notifyStatusRequest(
    situation:
      | 'agent_contract.status_request_raised'
      | 'agent_contract.status_request_resolved',
    request: IContractStatusRequest,
    recipientRole: 'agent' | 'agency'
  ): void {
    const contractId = request.contract_id.toString();
    const agentId = request.agent_id.toString();
    const agencyId = request.agency_id.toString();

    void (async () => {
      // Only the name the RECIPIENT needs, same as notifyHandshake.
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
          requestId: request._id.toString(),
          recipientRole,
          agentId,
          agencyId,
          agentName: agent?.name ?? '',
          agencyName: agencyName ?? '',
          transition: request.transition,
          // 'approved' | 'rejected' | 'cancelled' on a resolution; 'pending' on
          // a raise, where the handler ignores it.
          state: request.state,
          requestedByRole: request.requested_by_role,
        },
      });
    })().catch((err) => console.error(`[AgentContractService] ${situation} emit failed:`, err));
  }

  /**
   * Tell the other party about a terms proposal on a LIVE contract, or about
   * its answer.
   *
   * A third notifier rather than a branch in the other two, because this one
   * carries what the recipient actually needs to decide: which groups are being
   * changed, and — for `terms_proposed` — the fact that their current terms
   * remain in force until they answer. A recipient who reads "your pay is being
   * changed" and cannot tell whether it has already happened will act on the
   * wrong assumption.
   *
   * Post-commit and fire-and-forget, per the module convention.
   */
  private notifyTermsProposal(
    situation: 'agent_contract.terms_proposed' | 'agent_contract.terms_resolved',
    proposal: IContractTermsProposal,
    recipientRole: 'agent' | 'agency'
  ): void {
    const agentId = proposal.agent_id.toString();
    const agencyId = proposal.agency_id.toString();

    void (async () => {
      // Only the name the RECIPIENT needs, same as notifyHandshake.
      const [agent, agencyName] =
        recipientRole === 'agent'
          ? [null, await this.magazins.findNameByAgencyId(agencyId)]
          : [await this.agents.findById(agentId), null];

      await eventBus.publish(situation, {
        eventType: situation,
        aggregateId: proposal.contract_id.toString(),
        occurredAt: new Date(),
        payload: {
          contractId: proposal.contract_id.toString(),
          proposalId: proposal._id.toString(),
          recipientRole,
          agentId,
          agencyId,
          agentName: agent?.name ?? '',
          agencyName: agencyName ?? '',
          proposedByRole: proposal.proposed_by_role,
          // 'accepted' | 'rejected' | 'withdrawn' | 'superseded' on a
          // resolution; 'pending' on a raise, where the handler ignores it.
          state: proposal.state,
          changedTerms: Object.keys(proposal.proposed_terms ?? {}),
        },
      });
    })().catch((err) => console.error(`[AgentContractService] ${situation} emit failed:`, err));
  }

  /** The party on the other side of a two-party transition. */
  private counterpartyOf(party: 'agent' | 'agency'): 'agent' | 'agency' {
    return party === 'agent' ? 'agency' : 'agent';
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
   *
   * `terms` is REQUIRED here, unlike on the agent's side. An agency naming a
   * specific agent is making an offer, and an offer with no numbers in it is
   * not one — it would land the agent on `contractDefaults.feeSplit()`, which
   * pays zero. The agent may counter what they are shown; they may not be
   * shown nothing.
   */
  async requestFromAgency(
    agencyId: string,
    agentId: string,
    proposed: ContractTermsUpdate,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.gates.assertCanHoldContract(agentId);
    await this.assertNoLiveContract(agentId, agencyId);

    this.assertNegotiableBy('agency', proposed);
    const terms = await this.normalizeCoverageTerms(agencyId, proposed);
    // Checked against the schema defaults, since there is no stored split yet.
    this.assertFeeSplitCoherent(terms.fee_split ?? {}, contractDefaults.feeSplit());

    const contract = await transactionManager.runInTransaction(async (session) => {
      const contract = await this.contracts.create(
        {
          agentId,
          agencyId,
          status: 'pending',
          origin: 'invitation',
          terms,
          termsProposedBy: 'agency',
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
   *
   * `terms` is OPTIONAL here, and the asymmetry with `requestFromAgency` is
   * intended. An agent may state their asking rate and coverage up front — the
   * agency can then approve, reject or counter it — or apply bare, in which
   * case `terms_proposed_by` stays null and the agency must propose before
   * anyone can approve. Both land in the same place through one rule
   * (`assertTermsApprovable`) rather than two special cases.
   */
  async requestToJoin(
    agentId: string,
    agencyId: string,
    terms: ContractTermsUpdate | null,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    await this.gates.assertCanHoldContract(agentId);
    await this.assertNoLiveContract(agentId, agencyId);

    const raw = terms && Object.keys(terms).length > 0 ? terms : null;
    if (raw) this.assertNegotiableBy('agent', raw);
    const stated = raw ? await this.normalizeCoverageTerms(agencyId, raw) : null;
    if (stated) {
      // Stating terms means stating what you expect to be paid. Coverage alone
      // would leave the agent's own proposal carrying a null share — i.e. zero —
      // which the agency then could not approve. Applying bare is the supported
      // way to say "your terms, whatever they are".
      if (!stated.fee_split) {
        throw createAppError(ERROR_CODES.CONTRACT_TERMS_REQUIRED, 422, undefined, {
          hint:
            'A join request that states terms must include a fee split. Omit terms entirely to ' +
            'let the agency propose them.',
        });
      }
      this.assertFeeSplitCoherent(stated.fee_split, contractDefaults.feeSplit());
    }

    const contract = await transactionManager.runInTransaction(async (session) => {
      const created = await this.contracts.create(
        {
          agentId,
          agencyId,
          status: 'pending',
          origin: 'join_request',
          terms: stated ?? undefined,
          termsProposedBy: stated ? 'agent' : null,
          requestedAt: new Date(),
        },
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

    this.assertProposerRule(contract, transition, party);
    if (transition === 'approve') this.assertTermsApprovable(contract);

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

      // Tell the party whose TERMS WERE STANDING how they were answered. Only
      // the handshake pair — the lifecycle transitions (pause/suspend/
      // deactivate) have their own status-request inbox and are not notified
      // here. Emitted from this one place because both HTTP paths, agency and
      // agent, funnel through it.
      //
      // Computed from `contract` (as read BEFORE the transition), not from
      // `applied.contract`: after a counter the proposer is not the party that
      // opened the contract, and re-deriving it from the updated row would send
      // the answer to whoever the approval left standing.
      if ((transition === 'approve' || transition === 'reject') && applied.contract) {
        this.notifyHandshake(
          transition === 'approve' ? 'agent_contract.approved' : 'agent_contract.rejected',
          applied.contract,
          this.proposerOf(contract)
        );
      }

      return { request: applied.request, contract: applied.contract };
    }

    // Still pending: the counterparty is the one who has to act, so they are the
    // one told. Until now nothing was emitted here at all and the request simply
    // waited in an inbox nobody was pointed at.
    this.notifyStatusRequest(
      'agent_contract.status_request_raised',
      request,
      this.counterpartyOf(party)
    );

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
        // Terms first: a contract with nothing agreed to pay the agent has no
        // business reaching a KYC check. Failing here names the actual problem.
        this.assertTermsApprovable(contract);

        // Platform gates next: KYC and bans outrank everything else. An
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

    const result = await this.resolveRequest(requestId, decision, actor, { note });

    // Tell the party who RAISED it how it was answered. Emitted here rather than
    // in `resolveRequest` because that method is also the auto-approval path for
    // unilateral transitions, where the "requester" and the "resolver" are the
    // same person and there is nobody to inform.
    this.notifyStatusRequest(
      'agent_contract.status_request_resolved',
      result.request,
      this.counterpartyOf(party)
    );

    return result;
  }

  /**
   * Cancel a pending request as the party who RAISED it.
   *
   * The mirror of `resolveRequestAs`, and its two guards invert exactly: that
   * one refuses the requester, this one refuses everyone else. A pending
   * request is either answered by the counterparty or pulled back by its
   * author, and neither side may do the other's half.
   *
   * Only `requires_counterparty` transitions can ever be pending — everything
   * unilateral self-clears inside `requestTransition` — so in practice this
   * cancels an agent's `pause`/`reactivate` or either side's `deactivate`.
   * Cancelling frees the (contract, transition) pending slot, so the same
   * transition can be raised again afterwards.
   *
   * The contract is deliberately untouched. A cancelled request moved nothing,
   * so there is no transition to undo and no `evaluateDeactivationBlockers`
   * call to make — outstanding COD gates *ending* a contract, and abandoning a
   * proposal to end one is not that. `contract` is therefore always null,
   * matching the shape `resolveRequestAs` returns for a still-pending request
   * so one client decoder serves both.
   *
   * Deliberately NOT an AgentMembershipEvent either: that log records the
   * contract's state machine, and this never moved it. The request row's own
   * `state` / `resolved_by_role` / `resolved_at` is already the complete trail.
   */
  async cancelRequestAs(
    party: 'agent' | 'agency',
    ownerId: string,
    requestId: string,
    actor: Actor,
    note: string | null = null
  ): Promise<{ request: IContractStatusRequest; contract: null }> {
    const request = await this.requests.findById(requestId);
    if (!request) throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND, 404);

    // Scope first, and a foreign request 404s rather than 403s — same
    // "don't leak existence" rule as `resolveRequestAs`.
    const owner = party === 'agent' ? request.agent_id.toString() : request.agency_id.toString();
    if (owner !== ownerId) {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND, 404);
    }

    // Authorship: the inverse of the consent guard above.
    if (request.requested_by_role !== party) {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_YOURS, 403, undefined, {
        requestedByRole: request.requested_by_role,
        hint: 'You may only cancel a request you raised yourself. Use /resolve to answer the other party.',
      });
    }

    if (request.state !== 'pending') {
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_PENDING, 409, undefined, {
        state: request.state,
      });
    }

    // The repository's compare-and-set filters on `state: 'pending'`, so a
    // cancel racing the counterparty's approval yields exactly one winner. A
    // null means we lost — re-read so the 409 names the state that actually won
    // rather than the stale `pending` we read above.
    const cancelled = await this.requests.resolve(requestId, 'cancelled', actor, note);
    if (!cancelled) {
      const current = await this.requests.findById(requestId);
      throw createAppError(ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_PENDING, 409, undefined, {
        state: current?.state ?? 'resolved',
      });
    }

    // The counterparty was the one holding this in their inbox, so they are the
    // one told it is gone — otherwise a withdrawn proposal stays on their list
    // until they open it and find it already resolved.
    this.notifyStatusRequest(
      'agent_contract.status_request_resolved',
      cancelled,
      this.counterpartyOf(party)
    );

    return { request: cancelled, contract: null };
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
   * The agency's terms endpoint. **Status-aware, and that is the whole point.**
   *
   * On a `pending` contract this IS the agency's counter — it delegates to
   * `counterTerms` rather than duplicating it, because two code paths that both
   * write pending terms are two code paths that drift.
   *
   * On a live contract it REFUSES. The contract is pricing deliveries right now
   * by its agreed `fee_split`, and rewriting that under the agent is the thing
   * the negotiation exists to prevent. Live changes go through
   * `proposeTermsChange`, which stages them until the agent answers.
   *
   * `employment` keeps its own unilateral route and never reaches here — see
   * NEGOTIABLE_TERM_GROUPS for why.
   */
  async updateTerms(
    agencyId: string,
    contractId: string,
    terms: ContractTermsUpdate,
    actor: Actor,
    eventType: MembershipEventType = 'terms_updated'
  ): Promise<IAgentAgencyContract> {
    const contract = await this.loadForAgency(contractId, agencyId);

    if (contract.status === 'pending') {
      return await this.counterTerms('agency', agencyId, contractId, terms, actor);
    }

    // `employment_updated` is the one caller that legitimately writes live: it
    // is the agency's own HR record, not a negotiated term.
    if (eventType !== 'employment_updated') {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED, 409, undefined, {
        status: contract.status,
        hint:
          'The terms of a live contract change by proposal, not by edit. POST to ' +
          '/api/agency/agents/:membershipId/terms-proposals and the agent will answer it.',
      });
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

  // ─── Negotiation: PENDING contracts ───────────────────────────────────────

  /**
   * Write the terms standing on a PENDING contract — a counter, or a revision.
   *
   * No proposal row is involved: a pending contract has no agreed terms to
   * protect, so its own document IS the offer (see ContractTermsProposal's
   * header for why a live contract is different).
   *
   * ── Counter vs revision, and why both are allowed ───────────────────────
   *
   * Which one this is depends entirely on who is writing:
   *
   *  - **The counterparty** writing is a COUNTER. `terms_proposed_by` flips to
   *    them, which is what moves the right to approve to the other side.
   *  - **The proposer** writing is a REVISION of their own unanswered offer.
   *    The version bumps but the ball does NOT move — nobody has answered, so
   *    handing them the right to approve their own revised terms would be the
   *    consent bypass the whole handshake exists to prevent.
   *
   * Refusing the revision outright was the first design, on the reasoning that
   * it is "not a counter". But an agency that mistypes a percentage on an
   * invitation would then have to withdraw and re-request — destroying the
   * contract row, its history and the agent's notification thread — to fix a
   * digit nobody had looked at. There is no safety argument for that: the terms
   * are unanswered either way, and `terms_version` is what lets a client that
   * is mid-read notice it is now stale.
   *
   * A contract with `terms_proposed_by: null` has no proposer at all, so the
   * first write is a plain proposal by whoever makes it.
   */
  async counterTerms(
    party: ContractTermsParty,
    ownerId: string,
    contractId: string,
    proposed: ContractTermsUpdate,
    actor: Actor
  ): Promise<IAgentAgencyContract> {
    const contract = await this.loadForParty(party, contractId, ownerId);

    if (contract.status !== 'pending') {
      throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, undefined, {
        status: contract.status,
        hint: 'Only a pending contract is countered. A live one takes a terms proposal.',
      });
    }

    this.assertNegotiableBy(party, proposed);
    // The agency's country, whoever is countering: coverage is one catalogue per
    // contract, not one per party.
    const terms = await this.normalizeCoverageTerms(contract.agency_id.toString(), proposed);
    if (terms.fee_split) this.assertFeeSplitCoherent(terms.fee_split, contract.fee_split);

    const isRevision = contract.terms_proposed_by !== null && this.proposerOf(contract) === party;

    const updated = await this.contracts.updateTerms(contractId, terms, undefined, {
      termsProposedBy: party,
      bumpVersion: true,
    });
    if (!updated) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    await this.events.append({
      membershipId: contractId,
      agentId: contract.agent_id.toString(),
      agencyId: contract.agency_id.toString(),
      type: isRevision ? 'terms_updated' : 'terms_countered',
      actorUserId: actor.userId,
      actorRole: actor.role,
      metadata: {
        from: contract.terms_proposed_by,
        to: party,
        version: updated.terms_version,
        revision: isRevision,
        terms: terms as Record<string, unknown>,
      },
    });

    // Both are worth telling the other party about — a revised offer they have
    // not yet answered is still a changed offer — but only a counter hands them
    // the decision, so only a counter is announced as one.
    this.notifyHandshake('agent_contract.terms_countered', updated, this.counterpartyOf(party));
    return updated;
  }

  // ─── Negotiation: LIVE contracts ──────────────────────────────────────────

  /**
   * Propose a change to a live contract's terms.
   *
   * Writes a ContractTermsProposal and **does not touch the contract**. Work
   * continues under the agreed terms — EarningsQuoteService keeps dividing by
   * the stored `fee_split` — until the counterparty accepts. That is the
   * difference between negotiating and repricing someone's work mid-delivery.
   */
  async proposeTermsChange(
    party: ContractTermsParty,
    ownerId: string,
    contractId: string,
    proposed: ContractTermsUpdate,
    note: string | null,
    actor: Actor
  ): Promise<IContractTermsProposal> {
    const contract = await this.loadForParty(party, contractId, ownerId);

    if (!ALLOCATING_CONTRACT_STATUSES.includes(contract.status)) {
      throw createAppError(ERROR_CODES.CONTRACT_INVALID_TRANSITION, 409, undefined, {
        status: contract.status,
        allowedFrom: ALLOCATING_CONTRACT_STATUSES,
        hint: 'Only a live contract takes a terms proposal. A pending one is countered.',
      });
    }

    this.assertNegotiableBy(party, proposed);
    // Canonicalised BEFORE the proposal row is written, not when it is accepted:
    // the row is what both parties read while deciding, so it must show the
    // regions that would actually be stored.
    const terms = await this.normalizeCoverageTerms(contract.agency_id.toString(), proposed);
    if (terms.fee_split) this.assertFeeSplitCoherent(terms.fee_split, contract.fee_split);

    const open = await this.proposals.findPendingForContract(contractId);
    if (open) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING, 409, undefined, {
        proposalId: open._id.toString(),
        proposedByRole: open.proposed_by_role,
        hint: 'Resolve or counter the open proposal before raising another.',
      });
    }

    const proposal = await this.proposals.create({
      contractId,
      agentId: contract.agent_id.toString(),
      agencyId: contract.agency_id.toString(),
      proposedByRole: party,
      proposedByUserId: actor.userId,
      termsBefore: this.snapshotTermsBefore(contract, terms),
      proposedTerms: terms as ProposedTerms,
      note,
    });

    await this.events.append({
      membershipId: contractId,
      agentId: contract.agent_id.toString(),
      agencyId: contract.agency_id.toString(),
      type: 'terms_proposed',
      actorUserId: actor.userId,
      actorRole: actor.role,
      reason: note,
      metadata: { proposalId: proposal._id.toString(), terms: terms as Record<string, unknown> },
    });

    this.notifyTermsProposal(
      'agent_contract.terms_proposed',
      proposal,
      this.counterpartyOf(party)
    );
    return proposal;
  }

  /**
   * Answer a proposal raised by the other party.
   *
   * On accept, the terms are applied inside the same transaction that resolves
   * the proposal — a proposal marked accepted whose terms never landed would
   * leave both parties believing different things about what the agent is paid.
   */
  async resolveTermsProposalAs(
    party: ContractTermsParty,
    ownerId: string,
    proposalId: string,
    decision: 'approve' | 'reject',
    actor: Actor,
    note: string | null = null
  ): Promise<{ proposal: IContractTermsProposal; contract: IAgentAgencyContract | null }> {
    const proposal = await this.loadProposalForParty(party, proposalId, ownerId);

    // Consent: the counterparty answers, never the author.
    if (proposal.proposed_by_role === party) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_YOURS, 403, undefined, {
        proposedByRole: proposal.proposed_by_role,
        hint: 'The other party must answer a proposal you raised. You may cancel it instead.',
      });
    }

    const result = await transactionManager.runInTransaction(async (session) => {
      const contract = await this.contracts.findById(proposal.contract_id.toString(), session);
      if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      if (decision === 'reject') {
        const rejected = await this.proposals.resolve(
          proposalId,
          'rejected',
          { role: party, userId: actor.userId },
          note,
          session
        );
        if (!rejected) {
          throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING, 409);
        }
        return { proposal: rejected, contract };
      }

      const terms = proposal.proposed_terms as ContractTermsUpdate;

      // Re-checked against the contract's CURRENT split, not the snapshot: the
      // agreed terms may have moved since (a `/cod-limit` or `/employment`
      // write, or simply time), and coherence is a property of what will be
      // stored, not of what the proposer was looking at.
      if (terms.fee_split) this.assertFeeSplitCoherent(terms.fee_split, contract.fee_split);

      const updated = await this.contracts.applyAgreedTerms(
        proposal.contract_id.toString(),
        terms,
        proposal.proposed_by_role,
        session
      );
      if (!updated) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

      const accepted = await this.proposals.resolve(
        proposalId,
        'accepted',
        { role: party, userId: actor.userId },
        note,
        session
      );
      if (!accepted) {
        throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING, 409);
      }

      await this.events.append(
        {
          membershipId: proposal.contract_id.toString(),
          agentId: proposal.agent_id.toString(),
          agencyId: proposal.agency_id.toString(),
          type: 'terms_proposal_accepted',
          actorUserId: actor.userId,
          actorRole: actor.role,
          reason: note,
          metadata: {
            proposalId,
            version: updated.terms_version,
            terms: terms as Record<string, unknown>,
          },
        },
        session
      );

      return { proposal: accepted, contract: updated };
    });

    if (decision === 'reject') {
      await this.events.append({
        membershipId: proposal.contract_id.toString(),
        agentId: proposal.agent_id.toString(),
        agencyId: proposal.agency_id.toString(),
        type: 'terms_proposal_rejected',
        actorUserId: actor.userId,
        actorRole: actor.role,
        reason: note,
        metadata: { proposalId },
      });
    }

    this.notifyTermsProposal(
      'agent_contract.terms_resolved',
      result.proposal,
      this.counterpartyOf(party)
    );
    return result;
  }

  /**
   * Pull back a proposal you raised yourself.
   *
   * The mirror of `resolveTermsProposalAs`, guards inverted: that one refuses
   * the author, this one refuses everyone else. The contract is untouched — a
   * withdrawn proposal never applied anything.
   */
  async cancelTermsProposalAs(
    party: ContractTermsParty,
    ownerId: string,
    proposalId: string,
    actor: Actor,
    note: string | null = null
  ): Promise<IContractTermsProposal> {
    const proposal = await this.loadProposalForParty(party, proposalId, ownerId);

    if (proposal.proposed_by_role !== party) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_YOURS, 403, undefined, {
        proposedByRole: proposal.proposed_by_role,
        hint: 'Only the party that raised a proposal may cancel it. You may reject it instead.',
      });
    }

    const cancelled = await this.proposals.resolve(
      proposalId,
      'withdrawn',
      { role: party, userId: actor.userId },
      note
    );
    if (!cancelled) throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING, 409);

    await this.events.append({
      membershipId: proposal.contract_id.toString(),
      agentId: proposal.agent_id.toString(),
      agencyId: proposal.agency_id.toString(),
      type: 'terms_proposal_withdrawn',
      actorUserId: actor.userId,
      actorRole: actor.role,
      reason: note,
      metadata: { proposalId },
    });

    this.notifyTermsProposal(
      'agent_contract.terms_resolved',
      cancelled,
      this.counterpartyOf(party)
    );
    return cancelled;
  }

  /**
   * Counter an open proposal: supersede theirs, raise yours, in one transaction.
   *
   * `superseded` exists as a state precisely for this. A counter is not a
   * rejection — collapsing the two would lose the chain that shows how the
   * parties converged, and `supersedes_id` is what reconstructs it.
   */
  async counterTermsProposalAs(
    party: ContractTermsParty,
    ownerId: string,
    proposalId: string,
    proposed: ContractTermsUpdate,
    note: string | null,
    actor: Actor
  ): Promise<IContractTermsProposal> {
    const open = await this.loadProposalForParty(party, proposalId, ownerId);

    if (open.proposed_by_role === party) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_YOURS, 403, undefined, {
        proposedByRole: open.proposed_by_role,
        hint: 'You cannot counter your own proposal. Cancel it and raise another.',
      });
    }

    this.assertNegotiableBy(party, proposed);
    const terms = await this.normalizeCoverageTerms(open.agency_id.toString(), proposed);

    const contract = await this.contracts.findById(open.contract_id.toString());
    if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);
    if (terms.fee_split) this.assertFeeSplitCoherent(terms.fee_split, contract.fee_split);

    const counter = await transactionManager.runInTransaction(async (session) => {
      const superseded = await this.proposals.resolve(
        proposalId,
        'superseded',
        { role: party, userId: actor.userId },
        note,
        session
      );
      if (!superseded) {
        throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING, 409);
      }

      return await this.proposals.create(
        {
          contractId: open.contract_id.toString(),
          agentId: open.agent_id.toString(),
          agencyId: open.agency_id.toString(),
          proposedByRole: party,
          proposedByUserId: actor.userId,
          termsBefore: this.snapshotTermsBefore(contract, terms),
          proposedTerms: terms as ProposedTerms,
          note,
          supersedesId: proposalId,
        },
        session
      );
    });

    await this.events.append({
      membershipId: open.contract_id.toString(),
      agentId: open.agent_id.toString(),
      agencyId: open.agency_id.toString(),
      type: 'terms_proposal_superseded',
      actorUserId: actor.userId,
      actorRole: actor.role,
      reason: note,
      metadata: {
        supersededProposalId: proposalId,
        proposalId: counter._id.toString(),
        terms: terms as Record<string, unknown>,
      },
    });

    this.notifyTermsProposal(
      'agent_contract.terms_proposed',
      counter,
      this.counterpartyOf(party)
    );
    return counter;
  }

  // ─── Terms-proposal inbox ─────────────────────────────────────────────────

  async listPendingProposalsForAgent(agentId: string): Promise<IContractTermsProposal[]> {
    return await this.proposals.listPendingForAgent(agentId);
  }

  async listPendingProposalsForAgency(agencyId: string): Promise<IContractTermsProposal[]> {
    return await this.proposals.listPendingForAgency(agencyId);
  }

  /** One contract's negotiation trail. Scoped so a foreign contract 404s. */
  async listProposalsForContract(
    party: ContractTermsParty,
    ownerId: string,
    contractId: string
  ): Promise<IContractTermsProposal[]> {
    await this.loadForParty(party, contractId, ownerId);
    return await this.proposals.listForContract(contractId);
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

      // Carry the negotiated terms across, for exactly the reason the primary
      // standing is carried: losing them silently is not a neutral default.
      // See `contractTermsOf` for what goes wrong without this.
      //
      // The destination agency is not bound to them — they may propose a change
      // like any other live-contract term, and the agent answers.
      const carriedTerms = contractTermsOf(source);

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
          terms: carriedTerms,
          // The terms came from a contract both parties had agreed, so they are
          // not an open offer awaiting anyone. Attributed to the destination
          // agency because they are the party who now stands behind them.
          termsProposedBy: 'agency',
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
   * Which party raised this contract. **Legacy fallback only** — use
   * `proposerOf` for any authority decision.
   *
   * `origin` is the agent↔agency equivalent of `requester_role` on the
   * vendor↔agency connection. Only `join_request` is agent-raised; `invitation`
   * (an agency requesting a specific agent), `transfer`, `admin` and
   * `migration` are all agency- or platform-raised.
   *
   * It used to BE the approver discriminator, which worked only because nothing
   * could change the terms after creation. It cannot express a counter-proposal
   * — `origin` is immutable, and a counter is precisely the ball changing hands.
   */
  private initiatorOf(contract: IAgentAgencyContract): 'agent' | 'agency' {
    return contract.origin === 'join_request' ? 'agent' : 'agency';
  }

  /**
   * Which party's terms are currently standing — THE authority discriminator.
   *
   * The counterparty of this party answers (approve/reject/counter); this party
   * withdraws. A counter flips `terms_proposed_by`, so the answer changes as the
   * negotiation moves.
   *
   * Falls back to `origin` when `terms_proposed_by` is null. That covers two
   * cases and treats them identically, correctly: a contract written before
   * this field existed (whose behaviour was defined by `origin`, so it is
   * preserved exactly), and a bare agent join-request carrying no terms. The
   * second is only reachable for `withdraw` — `approve` is refused outright by
   * `assertTermsApprovable`, because terms nobody stated cannot be consented to.
   */
  private proposerOf(contract: IAgentAgencyContract): 'agent' | 'agency' {
    return contract.terms_proposed_by ?? this.initiatorOf(contract);
  }

  /**
   * Enforce "the other side answers, your side withdraws" for the three
   * transitions whose permitted party depends on who proposed the terms.
   *
   * Without this, `TRANSITION_AUTHORITY.approve` being `unilateral` for both
   * parties would let whoever's terms are standing approve them themselves —
   * which is exactly the consent the handshake exists to obtain.
   */
  private assertProposerRule(
    contract: IAgentAgencyContract,
    transition: ContractTransition,
    party: 'agent' | 'agency'
  ): void {
    const proposerOnly = PROPOSER_SCOPED_TRANSITIONS[transition];
    if (proposerOnly === undefined) return;

    const proposer = this.proposerOf(contract);
    if (proposerOnly === (party === proposer)) return;

    throw createAppError(ERROR_CODES.CONTRACT_TRANSITION_NOT_PERMITTED, 403, undefined, {
      transition,
      party,
      proposer,
      hint: proposerOnly
        ? 'Only the party whose terms are standing may withdraw them.'
        : 'The other party must respond to the terms you proposed.',
    });
  }

  /**
   * A pending contract may only be approved if there are terms to approve.
   *
   * Two failures, one guard. `terms_proposed_by: null` means no party has
   * stated terms — the state a bare agent join-request lands in, and the state
   * every legacy row was migrated into unless its stored split was already
   * coherent. Approving there would bind the agent to
   * `contractDefaults.feeSplit()`, whose `agent_share_percent` is null, which
   * `applyFeeSplit` resolves to a cut of ZERO. The agent would be consenting to
   * a number nobody chose and nobody showed them.
   *
   * The coherence half catches the same outcome arriving by a different route:
   * terms that were stated but leave the model without the field it pays from.
   */
  private assertTermsApprovable(contract: IAgentAgencyContract): void {
    if (contract.terms_proposed_by === null) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_NOT_PROPOSED, 422, undefined, {
        contractId: contract._id.toString(),
        hint:
          'No party has proposed terms on this contract yet. The agency must propose terms ' +
          'before it can be approved.',
      });
    }
    // Merging an empty patch over the stored split checks the stored split itself.
    this.assertFeeSplitCoherent({}, contract.fee_split);
  }

  /**
   * Restrict which term groups a party may write.
   *
   * The agency may propose anything negotiable; the agent may propose only what
   * describes their own side of the bargain — what they are paid and where they
   * will work. Everything else is the agency's risk control: the agent answers
   * it, but does not author it.
   */
  private assertNegotiableBy(party: ContractTermsParty, terms: ContractTermsUpdate): void {
    const allowed: readonly string[] =
      party === 'agent' ? AGENT_NEGOTIABLE_TERM_GROUPS : NEGOTIABLE_TERM_GROUPS;

    const offending = Object.entries(terms)
      .filter(([group, value]) => value !== undefined && !allowed.includes(group))
      .map(([group]) => group);

    if (offending.length > 0) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_NOT_NEGOTIABLE, 403, undefined, {
        party,
        offending,
        negotiable: allowed,
        hint:
          party === 'agent'
            ? 'An agent may only propose the fee split and coverage.'
            : 'Employment and the COD threshold have their own endpoints and are not negotiated.',
      });
    }
  }

  /**
   * Canonicalise `coverage.regions` on a terms patch, against the AGENCY's
   * registered country.
   *
   * Every path that writes terms — both request paths, the agency's patch, a
   * counter on either side, a proposal on a live contract, and a counter to one
   * — runs through here, because a term is only as good as its weakest write
   * path: validate the picker's endpoint but miss the counter, and the value the
   * two parties actually settle on is the unvalidated one.
   *
   * A no-op unless the patch touches `coverage.regions`, so the employment and
   * fee-split routes pay nothing for it. The agency lookup costs one read on a
   * negotiation write, which happens a handful of times per contract in its
   * lifetime.
   *
   * Returns a NEW patch rather than mutating: these objects are handed straight
   * to the repository and stored on proposals, and a caller's request body is
   * not ours to rewrite.
   */
  private async normalizeCoverageTerms<T extends ContractTermsUpdate>(
    agencyId: string,
    terms: T
  ): Promise<T> {
    const regions = terms.coverage?.regions;
    if (regions === undefined) return terms;

    const agency = await this.agencies.findById(agencyId);
    return {
      ...terms,
      coverage: {
        ...terms.coverage,
        regions: normalizeContractRegions(regions, agency?.country ?? null),
      },
    };
  }

  /** The agreed value of each group a patch touches — the proposal's `before`. */
  private snapshotTermsBefore(
    contract: IAgentAgencyContract,
    terms: ContractTermsUpdate
  ): ProposedTerms {
    const before: ProposedTerms = {};
    for (const group of Object.keys(terms) as Array<keyof ContractTermsUpdate>) {
      if (terms[group] === undefined) continue;
      const current = (contract as unknown as Record<string, unknown>)[group];
      // Inert data, not a live reference that would follow the contract as it
      // changes — see plainOf.
      before[group] = plainOf(current) ?? null;
    }
    return before;
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

  /** `loadForAgency` generalised to either party. Same 404-not-403 rule. */
  private async loadForParty(
    party: ContractTermsParty,
    contractId: string,
    ownerId: string
  ): Promise<IAgentAgencyContract> {
    const contract = await this.contracts.findById(contractId);
    if (!contract) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    const owner =
      party === 'agent' ? contract.agent_id.toString() : contract.agency_id.toString();
    if (owner !== ownerId) throw createAppError(ERROR_CODES.CONTRACT_NOT_FOUND, 404);

    return contract;
  }

  /**
   * Load a proposal addressed to this party, and assert it is still open.
   *
   * Scope first, then state: a foreign proposal must 404 rather than leak that
   * it exists by reporting it already resolved.
   */
  private async loadProposalForParty(
    party: ContractTermsParty,
    proposalId: string,
    ownerId: string
  ): Promise<IContractTermsProposal> {
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal) throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_FOUND, 404);

    const owner =
      party === 'agent' ? proposal.agent_id.toString() : proposal.agency_id.toString();
    if (owner !== ownerId) {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_FOUND, 404);
    }

    if (proposal.state !== 'pending') {
      throw createAppError(ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING, 409, undefined, {
        state: proposal.state,
      });
    }
    return proposal;
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
