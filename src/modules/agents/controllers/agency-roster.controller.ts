import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentCodThresholdService } from '../domain/services/agent-cod-threshold.service';
import { agentInviteService } from '../domain/services/agent-invite.service';
import { agentEligibilityService } from '../domain/services/agent-eligibility.service';
import { agentRepository } from '../repositories/agent.repository';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import { ContractStatusRequestMapper } from '../dto/contract-status-request.dto';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import {
  MembershipIdParamSchema,
  SuspendMembershipSchema,
  RemoveMembershipSchema,
  DeclineRequestSchema,
  UpdateEmploymentSchema,
  SetCodLimitSchema,
  ListMembershipsQuerySchema,
  InviteAgentSchema,
  ListInvitesQuerySchema,
} from '../validators/agent.validator';
import { codCashAccountService } from '../../cod/services/cod-cash-account.service';

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
  // ─── Invites ────────────────────────────────────────────────────────────

  /**
   * POST /api/agency/agents/invites — Body: { email }
   * An agent already serving another agency is a valid invitee; only a live
   * membership with THIS agency blocks it.
   */
  static invite = asyncHandler(async (req: Request, res: Response) => {
    const { email } = InviteAgentSchema.parse(req.body);
    const invite = await agentInviteService.invite(agencyId(req), email, req.auth!.user.id);

    res.status(201).json({
      success: true,
      data: {
        id: invite._id.toString(),
        email: invite.email,
        status: invite.status,
        createdAt: invite.created_at,
      },
      message: 'Invite sent. The agent will see it once signed up with this email.',
    });
  });

  /** GET /api/agency/agents/invites?status= */
  static listInvites = asyncHandler(async (req: Request, res: Response) => {
    const { status } = ListInvitesQuerySchema.parse(req.query);
    const invites = await agentInviteService.listInvites(agencyId(req), status);
    res.json({ success: true, data: invites });
  });

  /** DELETE /api/agency/agents/invites/:id */
  static revokeInvite = asyncHandler(async (req: Request, res: Response) => {
    const invite = await agentInviteService.revokeInvite(agencyId(req), req.params.id, actorOf(req));
    res.json({ success: true, data: invite, message: 'Invite revoked.' });
  });

  // ─── Roster ─────────────────────────────────────────────────────────────

  /**
   * GET /api/agency/agents?status=
   * The roster: memberships joined to their agent records, with cash held.
   */
  static listAgents = asyncHandler(async (req: Request, res: Response) => {
    const { status } = ListMembershipsQuerySchema.parse(req.query);
    const memberships = await agentContractService.listForAgency(agencyId(req), status);

    const agentIds = memberships.map((m) => m.agent_id.toString());
    const agents = await agentRepository.findManyByIds(agentIds);
    const agentById = new Map(agents.map((a) => [a._id.toString(), a]));
    const cashBalances = await codCashAccountService.getBalances('agent', agentIds);

    const data = memberships.map((membership) => {
      const agent = agentById.get(membership.agent_id.toString());
      return {
        membership: AgentMembershipMapper.toDto(membership),
        agent: agent ? AgentProfileMapper.toRosterEntryDto(agent) : null,
        cashHeld: cashBalances.get(membership.agent_id.toString()) ?? 0,
      };
    });

    res.json({ success: true, data });
  });

  /** GET /api/agency/agents/:membershipId */
  static getAgent = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.getForAgency(agencyId(req), membershipId);
    const agent = await agentRepository.findById(membership.agent_id.toString());

    res.json({
      success: true,
      data: {
        membership: AgentMembershipMapper.toDto(membership),
        agent: agent ? AgentProfileMapper.toResponseDto(agent) : null,
      },
    });
  });

  // ─── Approval ───────────────────────────────────────────────────────────

  /** POST /api/agency/agents/:membershipId/approve — approve a join request. */
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.approve(agencyId(req), membershipId, actorOf(req));
    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Agent approved. They can now receive shipments.',
    });
  });

  /** POST /api/agency/agents/:membershipId/decline — decline a join request. */
  static decline = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const { reason } = DeclineRequestSchema.parse(req.body ?? {});
    const membership = await agentContractService.declineRequest(
      agencyId(req),
      membershipId,
      reason ?? null,
      actorOf(req)
    );
    res.json({ success: true, data: AgentMembershipMapper.toDto(membership), message: 'Request declined.' });
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

  /** POST /api/agency/agents/:membershipId/reinstate */
  static reinstate = asyncHandler(async (req: Request, res: Response) => {
    const { membershipId } = MembershipIdParamSchema.parse(req.params);
    const membership = await agentContractService.reinstate(agencyId(req), membershipId, actorOf(req));
    res.json({ success: true, data: AgentMembershipMapper.toDto(membership), message: 'Agent reinstated.' });
  });

  // ─── Removal ────────────────────────────────────────────────────────────

  /**
   * DELETE /api/agency/agents/:membershipId
   *
   * Proposes termination; it does not perform it. Ending a contract needs the
   * agent's consent AND the §4 conditions (their cash returned, their wages
   * paid), so this returns the REQUEST and the contract stays live until both
   * are satisfied. `contract` is null whenever the request is still pending —
   * which, for an agency-initiated deactivation, is always on this first call.
   */
  static remove = asyncHandler(async (req: Request, res: Response) => {
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
        request: ContractStatusRequestMapper.toDto(request),
        membership: contract ? AgentMembershipMapper.toDto(contract) : null,
      },
      message: contract
        ? 'Agent removed from your roster.'
        : 'Removal requested. The contract ends once the agent agrees and any cash and unpaid earnings are settled.',
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
    res.json({ success: true, data: agents.map(AgentProfileMapper.toRosterEntryDto) });
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
