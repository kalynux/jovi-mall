import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentRosterService } from '../services/agent-roster.service';
import { IDeliveryAgent } from '../delivery-agent.model';

/**
 * Agent Invites Controller - the agent side of the agent↔agency membership
 * flow: view pending invites addressed to this agent's email, accept one
 * (links the agent to the agency), or decline.
 */
export class AgentInvitesController {
  /** GET /api/agent/invites */
  static listInvites = asyncHandler(async (req: Request, res: Response) => {
    const agent = req.auth!.role_entity as IDeliveryAgent;

    const invites = await agentRosterService.listInvitesForAgent(agent);

    res.json({ success: true, data: invites });
  });

  /** POST /api/agent/invites/:id/accept */
  static acceptInvite = asyncHandler(async (req: Request, res: Response) => {
    const agent = req.auth!.role_entity as IDeliveryAgent;

    const result = await agentRosterService.acceptInvite(agent, req.params.id);

    res.json({
      success: true,
      data: result,
      message: 'Invite accepted. You are now part of the agency.',
    });
  });

  /** POST /api/agent/invites/:id/decline */
  static declineInvite = asyncHandler(async (req: Request, res: Response) => {
    const agent = req.auth!.role_entity as IDeliveryAgent;

    const invite = await agentRosterService.declineInvite(agent, req.params.id);

    res.json({ success: true, data: invite, message: 'Invite declined.' });
  });
}
