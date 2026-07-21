import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentProfileService } from '../domain/services/agent-profile.service';
import { agentTrackingPolicyService } from '../domain/services/agent-tracking-policy.service';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentEligibilityService } from '../domain/services/agent-eligibility.service';
import { agentRepository } from '../repositories/agent.repository';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import {
  SetAgentStatusSchema,
  SetTrackingAllowedSchema,
  TransferAgentSchema,
  AgentIdParamSchema,
  EligibilityQuerySchema,
} from '../validators/agent.validator';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

function actorOf(req: Request) {
  return { userId: req.auth!.user.id, role: req.auth!.role };
}

/**
 * AdminAgentController — platform-level agent administration.
 *
 * Two powers live here and nowhere else, both because they cross agency
 * boundaries:
 *   - account status (suspending the person, not one relationship)
 *   - transfer (moving an agent between agencies — an agency must not be able
 *     to pull an agent off a rival's roster)
 */
export class AdminAgentController {
  /** GET /api/admin/agents/:agentId */
  static getAgent = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const agent = await agentRepository.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const memberships = await agentContractService.listForAgent(agentId);

    res.json({
      success: true,
      data: {
        agent: AgentProfileMapper.toResponseDto(agent),
        memberships: memberships.map(AgentMembershipMapper.toDto),
      },
    });
  });

  /**
   * PATCH /api/admin/agents/:agentId/status
   * Suspending the ACCOUNT deliberately leaves memberships intact so that
   * reinstating restores the agent's relationships as they were.
   */
  static setStatus = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { status, reason } = SetAgentStatusSchema.parse(req.body);

    const profile = await agentProfileService.setStatus(agentId, status, reason ?? null);

    res.json({ success: true, data: profile, message: `Agent status set to ${status}.` });
  });

  /**
   * PUT /api/admin/agents/:agentId/tracking-allow
   * jovi-mall owns this flag; geo-tracker enforces it.
   */
  static setTrackingAllowed = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { allowed, reason } = SetTrackingAllowedSchema.parse(req.body);

    const agent = await agentTrackingPolicyService.setTrackingAllowed(
      agentId,
      allowed,
      reason ?? null,
      actorOf(req)
    );

    res.json({
      success: true,
      data: AgentProfileMapper.toResponseDto(agent).tracking,
      message: allowed ? 'Tracking enabled for this agent.' : 'Tracking disabled for this agent.',
    });
  });

  /** GET /api/admin/agents/:agentId/tracking-policy — what geo-tracker would see. */
  static getTrackingPolicy = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const policy = await agentTrackingPolicyService.resolve(agentId);
    res.json({ success: true, data: policy });
  });

  /**
   * POST /api/admin/agents/transfer
   * Body: { agentId, fromAgencyId, toAgencyId, reason? }
   */
  static transfer = asyncHandler(async (req: Request, res: Response) => {
    const { agentId, fromAgencyId, toAgencyId, reason } = TransferAgentSchema.parse(req.body);

    const result = await agentContractService.transfer(
      agentId,
      fromAgencyId,
      toAgencyId,
      reason ?? null,
      actorOf(req)
    );

    res.json({
      success: true,
      data: {
        from: AgentMembershipMapper.toDto(result.from),
        to: AgentMembershipMapper.toDto(result.to),
      },
      message: 'Agent transferred.',
    });
  });

  /** GET /api/admin/agents/:agentId/history — the full membership trail. */
  static getHistory = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const events = await agentMembershipEventRepository.listForAgent(agentId, 500);
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });

  /** GET /api/admin/agents/:agentId/eligibility?agencyId= */
  static getEligibility = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { agencyId } = EligibilityQuerySchema.parse(req.query);
    const result = await agentEligibilityService.evaluate(agentId, agencyId);
    res.json({ success: true, data: result });
  });
}
