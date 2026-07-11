import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentRosterService } from '../services/agent-roster.service';

const InviteAgentSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
});

const ListInvitesQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'revoked']).optional(),
});

/**
 * Agency Agents Controller - the agency side of the agent↔agency membership
 * flow: invite agents by email, manage pending invites, view/unlink the roster.
 */
export class AgencyAgentsController {
  /** POST /api/agency/agents/invites */
  static invite = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { email } = InviteAgentSchema.parse(req.body);

    const invite = await agentRosterService.invite(agencyId, email, req.auth!.user.id);

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

  /** GET /api/agency/agents/invites */
  static listInvites = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { status } = ListInvitesQuerySchema.parse(req.query);

    const invites = await agentRosterService.listInvites(agencyId, status);

    res.json({ success: true, data: invites });
  });

  /** DELETE /api/agency/agents/invites/:id */
  static revokeInvite = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const invite = await agentRosterService.revokeInvite(agencyId, req.params.id);

    res.json({ success: true, data: invite, message: 'Invite revoked.' });
  });

  /** GET /api/agency/agents */
  static listAgents = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const agents = await agentRosterService.listAgents(agencyId);

    res.json({ success: true, data: agents });
  });

  /** DELETE /api/agency/agents/:id */
  static unlinkAgent = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const agent = await agentRosterService.unlinkAgent(agencyId, req.params.id);

    res.json({ success: true, data: agent, message: 'Agent removed from your roster.' });
  });
}
