import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentProfileService } from '../domain/services/agent-profile.service';
import { agentAvailabilityService } from '../domain/services/agent-availability.service';
import { agentDeviceService } from '../domain/services/agent-device.service';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentInviteService } from '../domain/services/agent-invite.service';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import {
  UpdateAgentProfileSchema,
  AgentOnboardingStep1Schema,
  AgentOnboardingStep2Schema,
  UpdateAgentPreferencesSchema,
  UpdateAgentSettingsSchema,
  SetAvailabilitySchema,
  ReportDeviceCapabilitiesSchema,
  RequestToJoinSchema,
  ListMembershipsQuerySchema,
  MembershipIdParamSchema,
} from '../validators/agent.validator';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

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

  /** PATCH /api/agent/settings */
  static updateSettings = asyncHandler(async (req: Request, res: Response) => {
    const input = UpdateAgentSettingsSchema.parse(req.body);
    const profile = await agentProfileService.updateSettings(selfId(req), input);
    res.json({ success: true, data: profile.settings, message: 'Settings updated.' });
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

  // ─── Memberships (the agent's agency portfolio) ─────────────────────────

  /** GET /api/agent/memberships?status= */
  static listMemberships = asyncHandler(async (req: Request, res: Response) => {
    const { status } = ListMembershipsQuerySchema.parse(req.query);
    const memberships = await agentContractService.listForAgent(selfId(req), status);

    // Resolve agency names for the portfolio view.
    const names = await resolveAgencyNames(memberships.map((m) => m.agency_id.toString()));
    res.json({
      success: true,
      data: memberships.map((m) =>
        AgentMembershipMapper.toDtoWithAgency(m, names.get(m.agency_id.toString()) ?? null)
      ),
    });
  });

  /**
   * POST /api/agent/memberships/requests — apply to join an agency.
   * Creates a `pending` membership the agency must approve.
   */
  static requestToJoin = asyncHandler(async (req: Request, res: Response) => {
    const { agencyId } = RequestToJoinSchema.parse(req.body);

    const agency = await agencyRepo.findById(agencyId);
    if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

    const membership = await agentContractService.requestToJoin(selfId(req), agencyId, actorOf(req));

    res.status(201).json({
      success: true,
      data: AgentMembershipMapper.toDto(membership),
      message: 'Request sent. The agency will review it.',
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

  /** GET /api/agent/memberships/history */
  static getHistory = asyncHandler(async (req: Request, res: Response) => {
    const events = await agentMembershipEventRepository.listForAgent(selfId(req));
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });

  // ─── Invites ────────────────────────────────────────────────────────────

  /** GET /api/agent/invites — pending agency invites addressed to this agent. */
  static listInvites = asyncHandler(async (req: Request, res: Response) => {
    const invites = await agentInviteService.listInvitesForAgent(req.auth!.role_entity);
    res.json({ success: true, data: invites });
  });

  /** POST /api/agent/invites/:id/accept — creates an approved membership. */
  static acceptInvite = asyncHandler(async (req: Request, res: Response) => {
    const result = await agentInviteService.acceptInvite(
      req.auth!.role_entity,
      req.params.id,
      actorOf(req)
    );
    res.json({
      success: true,
      data: {
        invite: result.invite,
        membership: AgentMembershipMapper.toDto(result.membership),
      },
      message: 'You have joined the agency.',
    });
  });

  /** POST /api/agent/invites/:id/decline */
  static declineInvite = asyncHandler(async (req: Request, res: Response) => {
    const invite = await agentInviteService.declineInvite(
      req.auth!.role_entity,
      req.params.id,
      actorOf(req)
    );
    res.json({ success: true, data: invite, message: 'Invite declined.' });
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
