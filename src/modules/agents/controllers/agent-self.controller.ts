import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentProfileService } from '../domain/services/agent-profile.service';
import { agentAvailabilityService } from '../domain/services/agent-availability.service';
import { agentDeviceService } from '../domain/services/agent-device.service';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentDirectoryService } from '../domain/services/agent-directory.service';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { agentRepository } from '../repositories/agent.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import { ContractStatusRequestMapper } from '../dto/contract-status-request.dto';
import { ContractTermsProposalMapper } from '../dto/contract-terms-proposal.dto';
import {
  UpdateAgentProfileSchema,
  AgentOnboardingStep1Schema,
  AgentOnboardingStep2Schema,
  UpdateAgentPreferencesSchema,
  UpdateAgentDispatchSettingsSchema,
  SetAvailabilitySchema,
  ReportDeviceCapabilitiesSchema,
  RequestToJoinSchema,
  ListMembershipsQuerySchema,
  MembershipIdParamSchema,
  SetAgentPayoutMethodsSchema,
  RequestIdParamSchema,
  ResolveStatusRequestSchema,
  CancelStatusRequestSchema,
  RequestTransitionSchema,
  BrowseAgenciesForAgentQuerySchema,
  WithdrawContractSchema,
  CounterTermsAsAgentSchema,
  ProposeTermsChangeAsAgentSchema,
  ProposalIdParamSchema,
  ResolveTermsProposalSchema,
  CancelTermsProposalSchema,
} from '../validators/agent.validator';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IPayoutMethod, maskPayoutMethods } from '../../../core/types/payout.types';
import { agentDepositService } from '../../cod/services/agent-deposit.service';
import { CodPaginationQuerySchema } from '../../cod/validators/cod.validators';

const agencyRepo = new DeliveryAgencyRepository();
const magazinRepo = new MagazinRepository();

/** Every handler here is scoped to the caller's own agent record. */
function selfId(req: Request): string {
  return req.auth!.role_entity._id.toString();
}

function actorOf(req: Request) {
  return { userId: req.auth!.user.id, role: req.auth!.role };
}

/**
 * AgentSelfController — the agent acting on their own record.
 *
 * The agent id is always taken from `req.auth`, never from the path or body:
 * an agent must not be able to act on another agent by changing an id.
 */
export class AgentSelfController {
  // ─── Profile ────────────────────────────────────────────────────────────

  /** GET /api/agent/profile */
  static getProfile = asyncHandler(async (req: Request, res: Response) => {
    const profile = await agentProfileService.getProfile(selfId(req));
    res.json({ success: true, data: profile });
  });

  /** PATCH /api/agent/profile */
  static updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const input = UpdateAgentProfileSchema.parse(req.body);
    const profile = await agentProfileService.updateProfile(selfId(req), input);
    res.json({ success: true, data: profile, message: 'Profile updated.' });
  });

  /** GET /api/agent/profile/completion-status */
  static getCompletionStatus = asyncHandler(async (req: Request, res: Response) => {
    const status = await agentProfileService.getCompletionStatus(selfId(req));
    res.json({ success: true, data: status });
  });

  /**
   * PATCH /api/agent/onboarding/step
   * Body: { step: 1 | 2, ...stepFields }
   */
  static completeOnboardingStep = asyncHandler(async (req: Request, res: Response) => {
    const agentId = selfId(req);
    const step = Number(req.body?.step);

    if (step === 1) {
      const input = AgentOnboardingStep1Schema.parse(req.body);
      const result = await agentProfileService.completeStep1(agentId, input);
      res.json({ success: true, data: result, message: 'Vehicle setup saved.' });
      return;
    }
    if (step === 2) {
      const input = AgentOnboardingStep2Schema.parse(req.body);
      const result = await agentProfileService.completeStep2(agentId, input);
      res.json({ success: true, data: result, message: 'Onboarding complete.' });
      return;
    }

    throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID, 400, undefined, {
      step: req.body?.step,
      allowed: [1, 2],
    });
  });

  // ─── Preferences & settings ─────────────────────────────────────────────

  /** PATCH /api/agent/preferences */
  static updatePreferences = asyncHandler(async (req: Request, res: Response) => {
    const input = UpdateAgentPreferencesSchema.parse(req.body);
    const profile = await agentProfileService.updatePreferences(selfId(req), input);
    res.json({ success: true, data: profile.preferences, message: 'Preferences updated.' });
  });

  /**
   * GET /api/agent/dispatch-settings
   *
   * Returns the settable flags alongside the read-only capacity block, so the
   * app can render "auto-accept" and "3 of 20" from one call.
   */
  static getDispatchSettings = asyncHandler(async (req: Request, res: Response) => {
    const profile = await agentProfileService.getProfile(selfId(req));
    res.json({
      success: true,
      data: { settings: profile.settings, capacity: profile.capacity },
    });
  });

  /** PATCH /api/agent/dispatch-settings */
  static updateDispatchSettings = asyncHandler(async (req: Request, res: Response) => {
    const input = UpdateAgentDispatchSettingsSchema.parse(req.body);
    const profile = await agentProfileService.updateDispatchSettings(selfId(req), input);
    res.json({
      success: true,
      data: { settings: profile.settings, capacity: profile.capacity },
      message: 'Dispatch settings updated.',
    });
  });

  // ─── Availability & working state ───────────────────────────────────────

  /** GET /api/agent/availability */
  static getAvailability = asyncHandler(async (req: Request, res: Response) => {
    const profile = await agentProfileService.getProfile(selfId(req));
    res.json({
      success: true,
      data: { availability: profile.availability, workingState: profile.workingState },
    });
  });

  /** PUT /api/agent/availability — Body: { state, reason? } */
  static setAvailability = asyncHandler(async (req: Request, res: Response) => {
    const { state, reason } = SetAvailabilitySchema.parse(req.body);
    const agent = await agentAvailabilityService.setAvailability(selfId(req), state, reason ?? null);
    res.json({
      success: true,
      data: AgentProfileMapper.toResponseDto(agent).availability,
      message: `You are now ${state}.`,
    });
  });

  // ─── Device capabilities ────────────────────────────────────────────────

  /** GET /api/agent/device */
  static getDevice = asyncHandler(async (req: Request, res: Response) => {
    const device = await agentDeviceService.getCapabilities(selfId(req));
    res.json({ success: true, data: device });
  });

  /** PUT /api/agent/device — the app reporting what it can do. */
  static reportDevice = asyncHandler(async (req: Request, res: Response) => {
    const input = ReportDeviceCapabilitiesSchema.parse(req.body);
    const agent = await agentDeviceService.reportCapabilities(selfId(req), input);
    res.json({ success: true, data: agent.device, message: 'Device capabilities recorded.' });
  });

  // ─── Payout destination ─────────────────────────────────────────────────

  /**
   * GET /api/agent/payout-methods — masked, never the raw account.
   *
   * Read-back is masked on purpose (see PayoutMethodMasked): the agent already
   * knows their own account, and echoing it in full would make any read of this
   * profile a banking-detail leak.
   */
  static getPayoutMethods = asyncHandler(async (req: Request, res: Response) => {
    const agent = await agentRepository.findById(selfId(req));
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    res.json({ success: true, data: maskPayoutMethods(agent.payout_details) });
  });

  /**
   * PUT /api/agent/payout-methods — Body: { payout_details: [...] }
   *
   * Replaces the list wholesale rather than merging: it is ORDERED and the first
   * entry is the one payouts actually use, so reordering IS the edit and a
   * field-by-field merge would have no meaning. Same contract as vendor/agency.
   *
   * Required before a payout can be requested — `PayoutRequestService` refuses
   * with EARNINGS_PAYOUT_METHOD_MISSING otherwise, and the nightly auto-payout
   * sweep hits the same wall on the agent's behalf.
   */
  static setPayoutMethods = asyncHandler(async (req: Request, res: Response) => {
    const { payout_details } = SetAgentPayoutMethodsSchema.parse(req.body);
    const agent = await agentRepository.setPayoutDetails(
      selfId(req),
      payout_details as IPayoutMethod[]
    );
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    res.json({
      success: true,
      data: maskPayoutMethods(agent.payout_details),
      message: 'Payout methods updated.',
    });
  });

  // ─── Memberships (the agent's agency portfolio) ─────────────────────────

  /**
   * GET /api/agent/memberships?status=&page=&limit=
   *
   * Every status by default, terminal rows included — this is the agent's
   * relationship history, not just their live roster.
   */
  static listMemberships = asyncHandler(async (req: Request, res: Response) => {
    const { status, page, limit } = ListMembershipsQuerySchema.parse(req.query);
    const result = await agentContractService.listForAgent(selfId(req), { status }, { page, limit });

    // Resolve agency names for the portfolio view.
    const names = await resolveAgencyNames(result.data.map((m) => m.agency_id.toString()));
    res.json({
      success: true,
      data: result.data.map((m) =>
        AgentMembershipMapper.toDtoWithAgency(m, names.get(m.agency_id.toString()) ?? null)
      ),
      meta: {
        total: result.meta.total,
        page: result.meta.page,
        limit: result.meta.limit,
        totalPages: result.meta.pages,
      },
    });
  });

  /**
   * GET /api/agent/memberships/:membershipId
   *
   * One contract, with the agency's business name resolved. A contract that is
   * not this agent's reports 404, never 403.
   */
  static getMembership = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.getForAgent(selfId(req), membershipId);

    const names = await resolveAgencyNames([membership.agency_id.toString()]);
    res.json({
      success: true,
      data: AgentMembershipMapper.toDtoWithAgency(
        membership,
        names.get(membership.agency_id.toString()) ?? null
      ),
    });
  });

  /**
   * POST /api/agent/memberships/requests — Body: { agencyId, terms? }
   *
   * Apply to join an agency. Creates a `pending` contract.
   *
   * `terms` is optional and, if given, may only carry the agent's own two
   * levers (fee split + coverage). Sent bare, the contract lands with nobody's
   * terms standing and the agency must propose before anyone can approve.
   */
  static requestToJoin = asyncHandler(async (req: Request, res: Response) => {
    const { agencyId, terms } = RequestToJoinSchema.parse(req.body);

    const agency = await agencyRepo.findById(agencyId);
    if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

    const membership = await agentContractService.requestToJoin(
      selfId(req),
      agencyId,
      terms ?? null,
      actorOf(req)
    );

    res.status(201).json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: terms
        ? 'Request sent with your terms. The agency will accept, reject or counter them.'
        : 'Request sent. The agency will propose terms for you to review.',
    });
  });

  /**
   * POST /api/agent/memberships/:membershipId/counter — Body: the terms
   *
   * Counters the terms standing on a pending contract. Restricted to the fee
   * split and coverage; the right to approve moves to the agency.
   */
  static counterTerms = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const terms = CounterTermsAsAgentSchema.parse(req.body);
    const membership = await agentContractService.counterTerms(
      'agent',
      selfId(req),
      membershipId,
      terms,
      actorOf(req)
    );

    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Terms countered. The agency must now accept them.',
    });
  });

  // ─── Terms proposals (LIVE contracts) ─────────────────────────────────────

  /**
   * POST /api/agent/memberships/:membershipId/terms-proposals
   * Body: { terms, note? }
   *
   * Proposes a change to a live contract. The agreed terms keep applying until
   * the agency answers.
   */
  static proposeTermsChange = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { terms, note } = ProposeTermsChangeAsAgentSchema.parse(req.body);
    const proposal = await agentContractService.proposeTermsChange(
      'agent',
      selfId(req),
      membershipId,
      terms,
      note,
      actorOf(req)
    );

    res.status(201).json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agent'),
      message: 'Proposal sent. Your current terms stay in force until the agency answers.',
    });
  });

  /** GET /api/agent/memberships/:membershipId/terms-proposals — the trail. */
  static listContractProposals = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const proposals = await agentContractService.listProposalsForContract(
      'agent',
      selfId(req),
      membershipId
    );

    res.json({
      success: true,
      data: proposals.map((p) => ContractTermsProposalMapper.toDto(p, 'agent')),
    });
  });

  /** GET /api/agent/memberships/terms-proposals — this agent's open proposals. */
  static listTermsProposals = asyncHandler(async (req: Request, res: Response) => {
    const proposals = await agentContractService.listPendingProposalsForAgent(selfId(req));
    res.json({
      success: true,
      data: proposals.map((p) => ContractTermsProposalMapper.toDto(p, 'agent')),
    });
  });

  /** POST /api/agent/memberships/terms-proposals/:proposalId/resolve */
  static resolveTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { decision, note } = ResolveTermsProposalSchema.parse(req.body);
    const result = await agentContractService.resolveTermsProposalAs(
      'agent',
      selfId(req),
      proposalId,
      decision,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: {
        proposal: ContractTermsProposalMapper.toDto(result.proposal, 'agent'),
        contract: result.contract ? AgentMembershipMapper.toDto(result.contract) : null,
      },
      message: decision === 'approve' ? 'Terms updated.' : 'Proposal rejected.',
    });
  });

  /** POST /api/agent/memberships/terms-proposals/:proposalId/cancel */
  static cancelTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { note } = CancelTermsProposalSchema.parse(req.body);
    const proposal = await agentContractService.cancelTermsProposalAs(
      'agent',
      selfId(req),
      proposalId,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agent'),
      message: 'Proposal withdrawn.',
    });
  });

  /** POST /api/agent/memberships/terms-proposals/:proposalId/counter */
  static counterTermsProposal = asyncHandler(async (req: Request, res: Response) => {
    const { proposalId } = ProposalIdParamSchema.parse(req.params);
    const { terms, note } = ProposeTermsChangeAsAgentSchema.parse(req.body);
    const proposal = await agentContractService.counterTermsProposalAs(
      'agent',
      selfId(req),
      proposalId,
      terms,
      note,
      actorOf(req)
    );

    res.status(201).json({
      success: true,
      data: ContractTermsProposalMapper.toDto(proposal, 'agent'),
      message: 'Counter-proposal sent. The agency must now answer it.',
    });
  });

  /** PUT /api/agent/memberships/:membershipId/primary */
  static setPrimary = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.setPrimary(selfId(req), membershipId, actorOf(req));
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Primary agency updated.',
    });
  });

  /**
   * GET /api/agent/memberships/status-requests
   *
   * Every pending contract transition on this agent — BOTH the ones an agency
   * raised that await their consent (a removal, most often) and the ones they
   * raised themselves that await the agency's. The query filters on the agent
   * and on `pending`, nothing more; this list is also the only place a client
   * can learn the id of a request it raised, which is what `/cancel` needs.
   *
   * Read `awaitingMyDecision` per row rather than counting rows: it is what
   * separates "the agency wants you out — Approve/Reject" from "you asked to
   * leave — Cancel", and it is the right predicate for an unread badge.
   *
   * Named `status-requests`, not `requests`: `POST .../requests` already means
   * "apply to join an agency", a different thing entirely.
   */
  static listStatusRequests = asyncHandler(async (req: Request, res: Response) => {
    const requests = await agentContractService.listPendingRequestsForAgent(selfId(req));
    res.json({
      success: true,
      data: requests.map((r) => ContractStatusRequestMapper.toDto(r, 'agent')),
    });
  });

  /**
   * POST /api/agent/memberships/status-requests/:requestId/resolve
   * Body: { decision: 'approve' | 'reject', note? }
   */
  static resolveStatusRequest = asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = RequestIdParamSchema.parse(req.params);
    const { decision, note } = ResolveStatusRequestSchema.parse(req.body);

    const { request, contract } = await agentContractService.resolveRequestAs(
      'agent',
      selfId(req),
      requestId,
      decision,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: {
        request: ContractStatusRequestMapper.toDto(request, 'agent'),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: decision === 'approve' ? 'Request approved.' : 'Request rejected.',
    });
  });

  /**
   * POST /api/agent/memberships/status-requests/:requestId/cancel
   * Body: { note? }
   *
   * The other half of the inbox: `/resolve` answers what the agency raised,
   * this pulls back what the agent raised and the agency has not answered yet.
   * Refused (403) on a request the agency raised — that one is answered, not
   * cancelled.
   *
   * `membership` is always null: cancelling a proposal moves no contract.
   */
  static cancelStatusRequest = asyncHandler(async (req: Request, res: Response) => {
    const { requestId } = RequestIdParamSchema.parse(req.params);
    const { note } = CancelStatusRequestSchema.parse(req.body ?? {});

    const { request } = await agentContractService.cancelRequestAs(
      'agent',
      selfId(req),
      requestId,
      actorOf(req),
      note
    );

    res.json({
      success: true,
      data: { request: ContractStatusRequestMapper.toDto(request, 'agent'), membership: null },
      message: 'Request cancelled.',
    });
  });

  /**
   * POST /api/agent/memberships/:membershipId/transitions
   * Body: { transition: 'pause' | 'reactivate', reason? }
   *
   * The two lifecycle changes with no named endpoint of their own; ending a
   * contract is `/terminate`. Whether a transition takes effect at once or waits
   * for the agency is the authority matrix's call: both of these are
   * `requires_counterparty` for an agent today, so the response carries
   * `membership: null` until the agency resolves it.
   */
  static requestTransition = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { transition, reason } = RequestTransitionSchema.parse(req.body);

    const { request, contract } = await agentContractService.requestTransitionAsAgent(
      selfId(req),
      membershipId,
      transition,
      actorOf(req),
      reason
    );

    res.status(201).json({
      success: true,
      data: {
        request: ContractStatusRequestMapper.toDto(request, 'agent'),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: contract
        ? 'Contract updated.'
        : 'Request sent. It takes effect once the agency agrees.',
    });
  });

  /**
   * GET /api/agent/memberships/:membershipId/settlements?page=&limit=
   *
   * What this ONE agency's relationship owes and has settled. `/cod/balance`
   * answers the agent's total across every agency; this answers "am I square
   * with THIS agency?" — the question that decides whether a removal can go
   * through, since the deactivation gate is scoped per contract.
   */
  static listSettlements = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const agentId = selfId(req);
    const contract = await agentContractService.getForAgent(agentId, membershipId);

    const deposits = await agentDepositService.listForContract(
      agentId,
      contract.agency_id.toString(),
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
        payment: {
          outstandingToAgent: contract.payment?.outstanding_to_agent ?? 0,
          lifetimePaid: contract.payment?.lifetime_paid ?? 0,
          lastPaidAt: contract.payment?.last_paid_at ?? null,
        },
        deposits: deposits.data,
      },
      meta: deposits.meta,
    });
  });

  /** GET /api/agent/memberships/history */
  static getHistory = asyncHandler(async (req: Request, res: Response) => {
    const events = await agentMembershipEventRepository.listForAgent(selfId(req));
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });

  // ─── Agency directory ───────────────────────────────────────────────────

  /**
   * GET /api/agent/agencies/browse — the agency directory.
   *
   * Every row carries `contract: { id, status, ... } | null`, so the client can
   * render Apply / Pending / Connected without a second call. The mirror of
   * GET /api/agency/agents/browse, and of the vendor's
   * GET /api/vendor/agency-connections/browse.
   */
  static browseAgencies = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, ...filters } = BrowseAgenciesForAgentQuerySchema.parse(req.query);
    const result = await agentDirectoryService.browseAgenciesForAgent(selfId(req), {
      ...filters,
      page,
      limit,
    });
    res.json({ success: true, data: result.agencies, meta: result.meta });
  });

  // ─── Responding to an agency's request ──────────────────────────────────
  //
  // These three replace the old invite inbox. A request an agency raised is
  // simply a `pending` contract, so it arrives through
  // GET /api/agent/memberships?status=pending like everything else — there is
  // no separate invite object to accept any more.

  /**
   * The three handshake verbs. All are `unilateral` in the authority matrix, so
   * the contract always comes back — `contract!` rather than a nullable `data`,
   * matching the agency's equivalents. The two-party transitions are elsewhere
   * (`/terminate`, `/transitions`) and those DO return a nullable membership.
   */

  /** POST /api/agent/memberships/:membershipId/approve — → active. */
  static approveRequest = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { contract } = await agentContractService.requestTransitionAsAgent(
      selfId(req),
      membershipId,
      'approve',
      actorOf(req)
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract!),
      message: 'You have joined the agency.',
    });
  });

  /** POST /api/agent/memberships/:membershipId/reject — Body: { reason? } */
  static rejectRequest = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = WithdrawContractSchema.parse(req.body ?? {});
    const { contract } = await agentContractService.requestTransitionAsAgent(
      selfId(req),
      membershipId,
      'reject',
      actorOf(req),
      reason ?? null
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract!),
      message: 'Request rejected.',
    });
  });

  /**
   * POST /api/agent/memberships/:membershipId/withdraw — Body: { reason? }
   * Pulls back an application THIS agent raised, while it is still pending.
   */
  static withdrawRequest = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = WithdrawContractSchema.parse(req.body ?? {});
    const { contract } = await agentContractService.requestTransitionAsAgent(
      selfId(req),
      membershipId,
      'withdraw',
      actorOf(req),
      reason ?? null
    );
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract!),
      message: 'Application withdrawn.',
    });
  });

  /**
   * POST /api/agent/memberships/:membershipId/terminate — Body: { reason? }
   *
   * End an established contract. Unlike the vendor↔agency `terminate`, this is
   * NOT unilateral: `deactivate` requires the counterparty in the authority
   * matrix, and is additionally blocked while cash or wages are outstanding
   * under this contract. So `membership` comes back **null** and the contract
   * only moves once the agency resolves the request.
   */
  static terminate = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = WithdrawContractSchema.parse(req.body ?? {});

    const { request, contract } = await agentContractService.requestTransitionAsAgent(
      selfId(req),
      membershipId,
      'deactivate',
      actorOf(req),
      reason ?? null
    );

    res.json({
      success: true,
      data: {
        request: ContractStatusRequestMapper.toDto(request, 'agent'),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: 'Termination proposed. It takes effect once the agency agrees and nothing is outstanding.',
    });
  });
}

async function resolveAgencyNames(agencyIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(agencyIds)];
  const nameById = new Map<string, string>();
  // Business name lives on the Magazin (source of truth), keyed by agency_id.
  const magazinNames = await magazinRepo.findNamesByAgencyIds(unique);
  for (const id of unique) {
    const name = magazinNames.get(id)?.name;
    if (name) nameById.set(id, name);
  }
  return nameById;
}
