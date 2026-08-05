import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentCodThresholdService } from '../domain/services/agent-cod-threshold.service';
import { agentDirectoryService } from '../domain/services/agent-directory.service';
import { agentEligibilityService } from '../domain/services/agent-eligibility.service';
import { agentRepository } from '../repositories/agent.repository';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import { ContractStatusRequestMapper } from '../dto/contract-status-request.dto';
import { ContractTermsProposalMapper } from '../dto/contract-terms-proposal.dto';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import {
  MembershipIdParamSchema,
  SuspendMembershipSchema,
  RemoveMembershipSchema,
  DeclineRequestSchema,
  UpdateEmploymentSchema,
  UpdateContractTermsSchema,
  SetCodLimitSchema,
  ListMembershipsQuerySchema,
  BrowseAgentsQuerySchema,
  RequestAgentContractSchema,
  WithdrawContractSchema,
  RequestIdParamSchema,
  ResolveStatusRequestSchema,
  CancelStatusRequestSchema,
  CounterTermsAsAgencySchema,
  ProposeTermsChangeAsAgencySchema,
  ProposalIdParamSchema,
  ResolveTermsProposalSchema,
  CancelTermsProposalSchema,
} from '../validators/agent.validator';
import { agentDepositService } from '../../cod/services/agent-deposit.service';
import { CodPaginationQuerySchema } from '../../cod/validators/cod.validators';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { IDeliveryAgent } from '../models/agent.model';

const fileRepository = new FileRepositoryMongo();
const storageProvider = getStorageProvider();

/**
 * Batch-resolve each agent's avatar File reference into a `FileDetail` object
 * (same shape as product media), keyed by agentId. Lets the roster views render
 * file-based avatars without an N+1 lookup.
 */
async function resolveAgentAvatars(agents: IDeliveryAgent[]): Promise<Map<string, FileDetail | null>> {
  const byFileId = await resolveFileDetails(
    agents.map((a) => a.avatar_file_id?.toString() ?? null),
    fileRepository,
    storageProvider,
  );
  return new Map(
    agents.map((a) => {
      const fid = a.avatar_file_id?.toString() ?? null;
      return [a._id.toString(), fid ? byFileId.get(fid) ?? null : null];
    }),
  );
}

function agencyId(req: Request): string {
  return req.auth!.role_entity._id.toString();
}

function actorOf(req: Request) {
  return { userId: req.auth!.user.id, role: req.auth!.role };
}

/**
 * AgencyRosterController — the agency managing its agents.
 *
 * The agency id always comes from `req.auth`, and every membership lookup is
 * scoped to it in the service (a foreign membership reports 404, not 403 — an
 * agency should not be able to probe whether an agent belongs to a rival).
 */
export class AgencyRosterController {
  // ─── Directory & requests ───────────────────────────────────────────────

  /**
   * GET /api/agency/agents/browse — the platform-wide agent directory.
   *
   * Every row carries `contract: { id, status, ... } | null` so the client can
   * render Request / Pending / Connected without a second call. Mirrors
   * GET /api/agency/vendor-connections/browse.
   */
  static browseAgents = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, ...filters } = BrowseAgentsQuerySchema.parse(req.query);
    const result = await agentDirectoryService.browseAgentsForAgency(agencyId(req), {
      ...filters,
      page,
      limit,
    });
    res.json({ success: true, data: result.agents, meta: result.meta });
  });

  /**
   * POST /api/agency/agents/requests — Body: { agentId, terms }
   *
   * Asks a specific agent to contract, ON STATED TERMS. Lands `pending`; the
   * agent approves, rejects or counters. An agent already serving another
   * agency is a valid target — only a live contract with THIS agency blocks it.
   *
   * `terms` is required and must carry a fee split: an invitation with no
   * numbers would land the agent on a default that pays them zero.
   */
  static requestAgent = asyncHandler(async (req: Request, res: Response) => {
    const { agentId, terms } = RequestAgentContractSchema.parse(req.body);
    const contract = await agentContractService.requestFromAgency(
      agencyId(req),
      agentId,
      terms,
      actorOf(req),
    );

    res.status(201).json({
      success: true,
      data: AgentMembershipMapper.toDto(contract),
      message: 'Request sent. The agent must accept your terms before the contract becomes active.',
    });
  });

  /**
   * POST /api/agency/agents/:membershipId/counter — Body: the terms
   *
   * Counters the terms standing on a pending contract. The right to approve
   * moves to the agent.
   */
  static counterTerms = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const terms = CounterTermsAsAgencySchema.parse(req.body);
    const contract = await agentContractService.counterTerms(
      'agency',
      agencyId(req),
      membershipId,
      terms,
      actorOf(req),
    );

    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract),
      message: 'Terms countered. The agent must now accept them.',
    });
  });

  // ─── Terms proposals (LIVE contracts) ───────────────────────────────────

  /**
   * POST /api/agency/agents/:membershipId/terms-proposals — Body: { terms, note? }
   *
   * Proposes a change to a live contract. **The contract is not modified** —
   * work continues on the agreed terms until the agent accepts.
   */
  static proposeTermsChange = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { terms, note } = ProposeTermsChangeAsAgencySchema.parse(req.body);
    const proposal = await agentContractService.proposeTermsChange(
      'agency',
      agencyId(req),
      membershipId,
      terms,
      note,
      actorOf(req),
    );

    res.status(201).json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agency'),
      message: 'Proposal sent. The current terms stay in force until the agent answers.',
    });
  });

  /** GET /api/agency/agents/:membershipId/terms-proposals — the trail. */
  static listContractProposals = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const proposals = await agentContractService.listProposalsForContract(
      'agency',
      agencyId(req),
      membershipId,
    );

    res.json({
      success: true,
      data: proposals.map((p) => ContractTermsProposalMapper.toDto(p, 'agency')),
    });
  });

  /** GET /api/agency/agents/terms-proposals — this agency's open proposals. */
  static listTermsProposals = asyncHandler(async (req: Request, res: Response) => {
    const proposals = await agentContractService.listPendingProposalsForAgency(agencyId(req));
    res.json({
      success: true,
      data: proposals.map((p) => ContractTermsProposalMapper.toDto(p, 'agency')),
    });
  });

  /** POST /api/agency/agents/terms-proposals/:proposalId/resolve */
  static resolveTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { decision, note } = ResolveTermsProposalSchema.parse(req.body);
    const result = await agentContractService.resolveTermsProposalAs(
      'agency',
      agencyId(req),
      proposalId,
      decision,
      actorOf(req),
      note,
    );

    res.json({
      success: true,
      data: {
        proposal: ContractTermsProposalMapper.toDto(result.proposal, 'agency'),
        contract: result.contract ? AgentMembershipMapper.toDto(result.contract) : null,
      },
      message: decision === 'approve' ? 'Terms updated.' : 'Proposal rejected.',
    });
  });

  /** POST /api/agency/agents/terms-proposals/:proposalId/cancel */
  static cancelTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { note } = CancelTermsProposalSchema.parse(req.body);
    const proposal = await agentContractService.cancelTermsProposalAs(
      'agency',
      agencyId(req),
      proposalId,
      actorOf(req),
      note,
    );

    res.json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agency'),
      message: 'Proposal withdrawn.',
    });
  });

  /** POST /api/agency/agents/terms-proposals/:proposalId/counter — Body: { terms, note? } */
  static counterTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { terms, note } = ProposeTermsChangeAsAgencySchema.parse(req.body);
    const proposal = await agentContractService.counterTermsProposalAs(
      'agency',
      agencyId(req),
      proposalId,
      terms,
      note,
      actorOf(req),
    );

    res.status(201).json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agency'),
      message: 'Counter-proposal sent. The agent must now answer it.',
    });
  });

  /**
   * POST /api/agency/agents/:membershipId/withdraw — Body: { reason? }
   *
   * Pulls back a request THIS agency raised, while it is still pending.
   * Declining an agent's application is `/decline` — the initiator guard keeps
   * the two apart.
   */
  static withdrawRequest = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = WithdrawContractSchema.parse(req.body ?? {});
    const membership = await agentContractService.withdrawRequest(
      agencyId(req),
      membershipId,
      reason ?? null,
      actorOf(req),
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Request withdrawn.',
    });
  });

  // ─── Roster ─────────────────────────────────────────────────────────────

  /**
   * GET /api/agency/agents?status=&page=&limit=
   *
   * The roster: contracts joined to their agent records, with cash held. Every
   * status by default, terminal rows included — this is the agency's
   * relationship history, not only who is working today. Filter by `status` (or
   * use `/eligible`) for the live view.
   *
   * `cashHeld` is the contract's own `cod.outstanding_balance` — the cash this
   * agent holds for THIS agency. It used to be the agent's `CodCashAccount`
   * balance, which is the person's pot across every agency they serve: that
   * showed an agency money held for a rival, and contradicted
   * `membership.codOutstandingBalance` sitting right beside it in the same row.
   */
  static listAgents = asyncHandler(async (req: Request, res: Response) => {
    const { status, page, limit } = ListMembershipsQuerySchema.parse(req.query);
    const result = await agentContractService.listForAgency(agencyId(req), { status }, { page, limit });

    const agentIds = result.data.map((m) => m.agent_id.toString());
    const agents = await agentRepository.findManyByIds(agentIds);
    const agentById = new Map(agents.map((a) => [a._id.toString(), a]));
    const avatarByAgent = await resolveAgentAvatars(agents);

    const data = result.data.map((membership) => {
      const agent = agentById.get(membership.agent_id.toString());
      return {
        membership: AgentMembershipMapper.toDto(membership),
        agent: agent ? AgentProfileMapper.toRosterEntryDto(agent, avatarByAgent.get(agent._id.toString()) ?? null) : null,
        cashHeld: membership.cod?.outstanding_balance ?? 0,
      };
    });

    res.json({
      success: true,
      data,
      meta: {
        total: result.meta.total,
        page: result.meta.page,
        limit: result.meta.limit,
        totalPages: result.meta.pages,
      },
    });
  });

  /** GET /api/agency/agents/:membershipId */
  static getAgent = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.getForAgency(agencyId(req), membershipId);
    const agent = await agentRepository.findById(membership.agent_id.toString());
    const avatar = agent ? (await resolveAgentAvatars([agent])).get(agent._id.toString()) ?? null : null;

    res.json({
      success: true,
      data: {
        membership: AgentMembershipMapper.toDto(membership),
        agent: agent ? AgentProfileMapper.toResponseDto(agent, new Date(), avatar) : null,
      },
    });
  });

  // ─── The handshake ──────────────────────────────────────────────────────

  /** POST /api/agency/agents/:membershipId/approve — accept an agent's application. */
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.approve(agencyId(req), membershipId, actorOf(req));
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Agent approved. They can now receive shipments.',
    });
  });

  /** POST /api/agency/agents/:membershipId/reject — refuse an agent's application. */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = DeclineRequestSchema.parse(req.body ?? {});
    const membership = await agentContractService.declineRequest(
      agencyId(req),
      membershipId,
      reason ?? null,
      actorOf(req)
    );
    res.json({ success: true, data: AgentMembershipMapper.toDto(membership), message: 'Request rejected.' });
  });

  // ─── Suspension ─────────────────────────────────────────────────────────

  /**
   * POST /api/agency/agents/:membershipId/suspend
   * Stops new assignments. Existing shipments are intentionally untouched —
   * see AgentMembershipService.suspend.
   */
  static suspend = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = SuspendMembershipSchema.parse(req.body);
    const membership = await agentContractService.suspend(
      agencyId(req),
      membershipId,
      reason,
      actorOf(req)
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Agent suspended. They keep current shipments but receive no new ones.',
    });
  });

  /**
   * POST /api/agency/agents/:membershipId/pause
   *
   * The softer sibling of suspend: both stop new work, but `paused` reads as a
   * mutual break while `suspended` reads as a sanction, and only `paused` is a
   * transition the agent may also raise. Reinstate returns from either.
   */
  static pause = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = RemoveMembershipSchema.parse(req.body);
    const membership = await agentContractService.pause(
      agencyId(req),
      membershipId,
      reason ?? null,
      actorOf(req)
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Agent paused. They keep current shipments but receive no new ones.',
    });
  });

  /** POST /api/agency/agents/:membershipId/reinstate */
  static reinstate = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.reinstate(agencyId(req), membershipId, actorOf(req));
    res.json({ success: true, data: AgentMembershipMapper.toDto(membership), message: 'Agent reinstated.' });
  });

  // ─── Termination ────────────────────────────────────────────────────────

  /**
   * POST /api/agency/agents/:membershipId/terminate
   * DELETE /api/agency/agents/:membershipId — the same handler, kept as an alias.
   *
   * Proposes termination; it does not perform it. Ending a contract needs the
   * agent's consent AND the §4 conditions (their cash returned, their wages
   * paid), so this returns the REQUEST and the contract stays live until both
   * are satisfied. `membership` is null whenever the request is still pending —
   * which, for an agency-initiated deactivation, is always on this first call.
   *
   * Note this differs from the vendor↔agency `terminate`, which IS unilateral
   * and immediate. Cash and wages are the reason: no such obligations exist
   * between a vendor and an agency.
   */
  static terminate = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = RemoveMembershipSchema.parse(req.body ?? {});
    const { request, contract } = await agentContractService.requestDeactivation(
      agencyId(req),
      membershipId,
      reason ?? null,
      actorOf(req)
    );

    res.json({
      success: true,
      data: {
        request: ContractStatusRequestMapper.toDto(request, 'agency'),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: contract
        ? 'Agent removed from your roster.'
        : 'Removal requested. The contract ends once the agent agrees and any cash and unpaid earnings are settled.',
    });
  });

  // ─── Status-request inbox ───────────────────────────────────────────────

  /**
   * GET /api/agency/agents/status-requests
   *
   * Every pending contract transition on this agency's roster — BOTH the ones
   * an agent raised that await this agency's consent and the ones the agency
   * raised itself that await the agent's. The query filters on the agency and
   * on `pending`, nothing more; this list is also the only place a client can
   * learn the id of a request it raised, which is what `/cancel` needs.
   *
   * Read `awaitingMyDecision` per row rather than counting rows: it is what
   * separates "this agent wants to leave — Approve/Reject" from "you proposed
   * removing them — Cancel", and it is the right predicate for an unread badge.
   *
   * Without this, an agent's `deactivate` — which the authority matrix makes
   * `requires_counterparty` from both sides — would sit pending forever.
   */
  static listStatusRequests = asyncHandler(async (req: Request, res: Response) => {
    const requests = await agentContractService.listPendingRequestsForAgency(agencyId(req));
    res.json({
      success: true,
      data: requests.map((r) => ContractStatusRequestMapper.toDto(r, 'agency')),
    });
  });

  /**
   * POST /api/agency/agents/status-requests/:requestId/resolve
   * Body: { decision: 'approve' | 'reject', note? }
   *
   * The service refuses a request this agency raised itself — consent has to
   * come from the other party for it to mean anything.
   */
  static resolveStatusRequest = asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = RequestIdParamSchema.parse(req.params);
    const { decision, note } = ResolveStatusRequestSchema.parse(req.body);

    const { request, contract } = await agentContractService.resolveRequestAs(
      'agency',
      agencyId(req),
      requestId,
      decision,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: {
        request: ContractStatusRequestMapper.toDto(request, 'agency'),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: decision === 'approve' ? 'Request approved.' : 'Request rejected.',
    });
  });

  /**
   * POST /api/agency/agents/status-requests/:requestId/cancel
   * Body: { note? }
   *
   * The other half of the inbox: `/resolve` answers what the agent raised, this
   * pulls back what the agency raised and the agent has not answered yet — a
   * termination proposal thought better of, most often. Refused (403) on a
   * request the agent raised; that one is answered, not cancelled.
   *
   * `membership` is always null: cancelling a proposal moves no contract.
   */
  static cancelStatusRequest = asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = RequestIdParamSchema.parse(req.params);
    const { note } = CancelStatusRequestSchema.parse(req.body ?? {});

    const { request } = await agentContractService.cancelRequestAs(
      'agency',
      agencyId(req),
      requestId,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: { request: ContractStatusRequestMapper.toDto(request, 'agency'), membership: null },
      message: 'Request cancelled.',
    });
  });

  // ─── Agency-scoped agent config ─────────────────────────────────────────

  /** PATCH /api/agency/agents/:membershipId/employment */
  static updateEmployment = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const input = UpdateEmploymentSchema.parse(req.body);
    const membership = await agentContractService.updateEmployment(
      agencyId(req),
      membershipId,
      input,
      actorOf(req)
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Employment details updated.',
    });
  });

  /**
   * PATCH /api/agency/agents/:membershipId/terms
   *
   * Every negotiated term except the COD threshold, which is bounded by the
   * agent's shared pool and has its own endpoint below. `fee_split` is the one
   * that moves money: it is what the earnings split divides by at delivery.
   */
  static updateTerms = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const input = UpdateContractTermsSchema.parse(req.body);

    const membership = await agentContractService.updateTerms(
      agencyId(req),
      membershipId,
      input,
      actorOf(req)
    );

    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Contract terms updated.',
    });
  });

  /**
   * PATCH /api/agency/agents/:membershipId/cod-limit
   *
   * Sets this contract's slice of the agent's COD pool — a sub-allocation, not
   * an independent cap: the sum across the agent's allocating contracts may not
   * exceed their own `cod.max_threshold`, so a raise here can be refused by
   * another agency's slice. `headroomAfter` reports what is left of the pool so
   * the caller learns their room without a second request.
   *
   * The contract is loaded through the service first purely to scope it to this
   * agency (a foreign contract 404s) and to resolve the agent it belongs to.
   */
  static setCodLimit = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { threshold } = SetCodLimitSchema.parse(req.body);
    const contract = await agentContractService.getForAgency(agencyId(req), membershipId);

    const result = await agentCodThresholdService.setContractThreshold(
      contract.agent_id.toString(),
      membershipId,
      threshold
    );

    res.json({
      success: true,
      data: { membershipId, ...result },
      message: 'COD threshold updated.',
    });
  });

  /**
   * GET /api/agency/agents/:membershipId/settlements?page=&limit=
   *
   * This contract's cash history: every hand-over the agent declared or the
   * agency recorded, plus what is still outstanding under it. Deliberately a
   * projection of the deposits rather than its own ledger — the movements are
   * already recorded by AgentDeposit and CodCashLedger, and a third copy would
   * be one more thing to keep in agreement with the balance.
   */
  static listSettlements = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);
    const contract = await agentContractService.getForAgency(agencyId(req), membershipId);

    const deposits = await agentDepositService.listForContract(
      contract.agent_id.toString(),
      agencyId(req),
      page,
      limit
    );

    res.json({
      success: true,
      data: {
        membershipId,
        cod: {
          threshold: contract.cod?.threshold ?? 0,
          outstandingBalance: contract.cod?.outstanding_balance ?? 0,
          lifetimeSettled: contract.cod?.lifetime_settled ?? 0,
          lastSettledAt: contract.cod?.last_settled_at ?? null,
        },
        deposits: deposits.data,
      },
      meta: deposits.meta,
    });
  });

  // ─── Eligibility & history ──────────────────────────────────────────────

  /**
   * GET /api/agency/agents/:agentId/eligibility
   * Why an agent can or cannot be assigned right now — every failed rule at
   * once, so a dispatcher isn't made to fix blockers one at a time.
   */
  static getEligibility = asyncHandler(async (req: Request, res: Response) => {
    const result = await agentEligibilityService.evaluate(req.params.agentId, agencyId(req));
    res.json({ success: true, data: result });
  });

  /** GET /api/agency/agents/eligible — the dispatchable subset right now. */
  static listEligible = asyncHandler(async (req: Request, res: Response) => {
    const agentIds = await agentEligibilityService.listEligibleAgentIds(agencyId(req));
    const agents = await agentRepository.findManyByIds(agentIds);
    const avatarByAgent = await resolveAgentAvatars(agents);
    res.json({
      success: true,
      data: agents.map((a) => AgentProfileMapper.toRosterEntryDto(a, avatarByAgent.get(a._id.toString()) ?? null)),
    });
  });

  /** GET /api/agency/agents/:agentId/history */
  static getAgentHistory = asyncHandler(async (req: Request, res: Response) => {
    const events = await agentMembershipEventRepository.listForAgentInAgency(
      req.params.agentId,
      agencyId(req)
    );
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });

  /** GET /api/agency/agents/history — the whole roster's trail. */
  static getRosterHistory = asyncHandler(async (req: Request, res: Response) => {
    const events = await agentMembershipEventRepository.listForAgency(agencyId(req));
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });
}
