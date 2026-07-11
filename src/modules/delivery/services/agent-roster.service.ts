import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { AgentInviteRepository } from '../agent-invite.repository';
import { IAgentInvite, AgentInviteStatus } from '../agent-invite.model';
import { DeliveryAgentRepository } from '../delivery-agent.repository';
import { DeliveryAgencyRepository } from '../delivery-agency.repository';
import { IDeliveryAgent } from '../delivery-agent.model';
import { ShipmentModel } from '../../shipments/shipment.model';

/** Shipment statuses that keep an agent bound to their agency (work in flight). */
const ACTIVE_SHIPMENT_STATUSES = ['assigned', 'picked_up', 'in_transit', 'agent_delivered', 'failed'];

/**
 * AgentRosterService - the consensual agent↔agency membership flow.
 *
 * Agents self-signup independently; an agency builds its roster by inviting an
 * agent's email. Accepting writes `DeliveryAgent.agency_id` — the link that
 * `ShipmentService.assignAgent` (and all COD accountability) depends on.
 */
export class AgentRosterService {
  constructor(
    private readonly inviteRepo: AgentInviteRepository = new AgentInviteRepository(),
    private readonly agentRepo: DeliveryAgentRepository = new DeliveryAgentRepository(),
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  // ─── Agency side ────────────────────────────────────────────────────────────

  async invite(agencyId: string, email: string, invitedByUserId: string): Promise<IAgentInvite> {
    const normalized = email.toLowerCase();

    const existingPending = await this.inviteRepo.findPendingByAgencyAndEmail(agencyId, normalized);
    if (existingPending) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_ALREADY_PENDING, 409, undefined, {
        inviteId: existingPending._id.toString(),
      });
    }

    // An agent already linked (to this or another agency) can't be invited.
    const agent = await this.agentRepo.findByEmail(normalized);
    if (agent?.agency_id) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_ALREADY_IN_AGENCY, 409, undefined, {
        sameAgency: agent.agency_id.toString() === agencyId,
      });
    }

    return await this.inviteRepo.create({
      agency_id: agencyId,
      email: normalized,
      invited_by_user_id: invitedByUserId,
    });
  }

  async listInvites(agencyId: string, status?: AgentInviteStatus) {
    const invites = await this.inviteRepo.listByAgency(agencyId, status);
    return invites.map((invite) => this.toInviteDto(invite));
  }

  async revokeInvite(agencyId: string, inviteId: string) {
    const invite = await this.inviteRepo.findById(inviteId);
    if (!invite || invite.agency_id.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404);
    }
    const resolved = await this.inviteRepo.resolvePending(inviteId, 'revoked');
    if (!resolved) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }
    return this.toInviteDto(resolved);
  }

  async listAgents(agencyId: string) {
    const agents = await this.agentRepo.listByAgency(agencyId);
    return agents.map((agent) => this.toRosterDto(agent));
  }

  /**
   * Unlink an agent from the agency's roster. Blocked while the agent still
   * has shipments in flight (assignment scoping would break mid-delivery).
   * NOTE(cod): once agent cash accounts exist, unlinking is additionally
   * blocked while the agent holds undeposited COD cash (see M4).
   */
  async unlinkAgent(agencyId: string, agentId: string) {
    const agent = await this.agentRepo.findById(agentId);
    if (!agent || agent.agency_id?.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOT_IN_AGENCY, 404);
    }

    const activeShipments = await ShipmentModel.countDocuments({
      agent_id: agentId,
      status: { $in: ACTIVE_SHIPMENT_STATUSES },
    });
    if (activeShipments > 0) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_HAS_ACTIVE_SHIPMENTS, 422, undefined, {
        activeShipments,
      });
    }

    await this.assertNoOutstandingCash(agentId);

    const updated = await this.agentRepo.clearAgency(agentId, agencyId);
    if (!updated) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOT_IN_AGENCY, 404);
    }
    return this.toRosterDto(updated);
  }

  /** COD cash guard — wired up once agent cash accounts land (M4). */
  protected async assertNoOutstandingCash(_agentId: string): Promise<void> {
    // no-op until COD cash accounts exist
  }

  // ─── Agent side ─────────────────────────────────────────────────────────────

  async listInvitesForAgent(agent: IDeliveryAgent) {
    if (!agent.email) return [];
    const invites = await this.inviteRepo.listPendingByEmail(agent.email);

    // Resolve agency names for the inbox view.
    const agencyIds = [...new Set(invites.map((i) => i.agency_id.toString()))];
    const nameById = new Map<string, string>();
    await Promise.all(
      agencyIds.map(async (id) => {
        const agency = await this.agencyRepo.findById(id);
        if (agency) nameById.set(id, agency.agency_name);
      })
    );

    return invites.map((invite) => ({
      ...this.toInviteDto(invite),
      agencyName: nameById.get(invite.agency_id.toString()) ?? null,
    }));
  }

  async acceptInvite(agent: IDeliveryAgent, inviteId: string) {
    const invite = await this.loadOwnPendingInvite(agent, inviteId);

    if (agent.agency_id) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_ALREADY_IN_AGENCY, 409, undefined, {
        agencyId: agent.agency_id.toString(),
      });
    }

    const linked = await this.agentRepo.setAgency(
      agent._id.toString(),
      invite.agency_id.toString()
    );
    if (!linked) {
      // Raced by a concurrent accept — the guard on agency_id lost.
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_ALREADY_IN_AGENCY, 409);
    }

    const resolved = await this.inviteRepo.resolvePending(inviteId, 'accepted');
    return {
      invite: this.toInviteDto(resolved ?? invite),
      agencyId: invite.agency_id.toString(),
    };
  }

  async declineInvite(agent: IDeliveryAgent, inviteId: string) {
    const invite = await this.loadOwnPendingInvite(agent, inviteId);
    const resolved = await this.inviteRepo.resolvePending(invite._id.toString(), 'declined');
    if (!resolved) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }
    return this.toInviteDto(resolved);
  }

  private async loadOwnPendingInvite(agent: IDeliveryAgent, inviteId: string): Promise<IAgentInvite> {
    const invite = await this.inviteRepo.findById(inviteId);
    // Ownership by email match; report foreign invites as not found (no leaking).
    if (!invite || !agent.email || invite.email !== agent.email.toLowerCase()) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404);
    }
    if (invite.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }
    return invite;
  }

  // ─── DTOs ───────────────────────────────────────────────────────────────────

  private toInviteDto(invite: IAgentInvite) {
    return {
      id: invite._id.toString(),
      agencyId: invite.agency_id.toString(),
      email: invite.email,
      status: invite.status,
      respondedAt: invite.responded_at,
      createdAt: invite.created_at,
    };
  }

  private toRosterDto(agent: IDeliveryAgent) {
    return {
      id: agent._id.toString(),
      name: agent.name,
      email: agent.email ?? null,
      phone: agent.phone ?? null,
      avatarUrl: agent.avatar_url,
      status: agent.status,
      vehicleInfo: agent.vehicle_info,
      capacityStatus: agent.live_state?.current_capacity_status ?? 'offline',
      joinedAgencyAt: agent.updated_at,
    };
  }
}

export const agentRosterService = new AgentRosterService();
