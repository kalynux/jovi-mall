import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentInviteRepository, } from '../../repositories/agent-invite.repository';
import { IAgentInvite, AgentInviteStatus } from '../../models/agent-invite.model';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import {
  AgentMembershipEventRepository,
  agentMembershipEventRepository,
} from '../../repositories/agent-membership-event.repository';
import { AgentContractService, agentContractService, Actor } from './agent-contract.service';
import { IDeliveryAgent } from '../../models/agent.model';
import { IAgentAgencyMembership } from '../../models/agent-agency-membership.model';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';

/**
 * AgentInviteService — the invitation half of the membership lifecycle.
 *
 * Invitations are kept as their own model rather than folded into membership
 * rows because an invite exists BEFORE the agent does: an agency invites an
 * email address, which may belong to nobody yet. A membership needs a real
 * agent, so the two cannot be the same record.
 *
 * The handoff: accepting an invite is what creates the membership. This service
 * owns the invite; AgentContractService owns everything after.
 */
export class AgentInviteService {
  constructor(
    private readonly invites: AgentInviteRepository = new AgentInviteRepository(),
    private readonly agents: AgentRepository = agentRepository,
    private readonly memberships: AgentContractRepository = agentContractRepository,
    private readonly contractService: AgentContractService = agentContractService,
    private readonly events: AgentMembershipEventRepository = agentMembershipEventRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  // ─── Agency side ──────────────────────────────────────────────────────────

  /**
   * Invite an agent by email.
   *
   * Under multi-agency the old "already in an agency" rejection is wrong — an
   * agent serving agency A is a perfectly valid invitee for agency B. Only a
   * live membership with THIS agency blocks the invite.
   */
  async invite(agencyId: string, email: string, invitedByUserId: string): Promise<IAgentInvite> {
    const normalized = email.toLowerCase();

    const existingPending = await this.invites.findPendingByAgencyAndEmail(agencyId, normalized);
    if (existingPending) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_ALREADY_PENDING, 409, undefined, {
        inviteId: existingPending._id.toString(),
      });
    }

    // If the agent already exists, reject only when they are already OUR agent.
    const agent = await this.agents.findByEmail(normalized);
    if (agent) {
      const live = await this.memberships.findLive(agent._id.toString(), agencyId);
      if (live) {
        throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_ALREADY_EXISTS, 409, undefined, {
          status: live.status,
          membershipId: live._id.toString(),
        });
      }
    }

    const invite = await this.invites.create({
      agency_id: agencyId,
      email: normalized,
      invited_by_user_id: invitedByUserId,
    });

    // History is keyed by agent id, which we may not have yet — an invite to an
    // unregistered email has no agent to attribute. Record only when known.
    if (agent) {
      await this.events.append({
        membershipId: null,
        agentId: agent._id.toString(),
        agencyId,
        type: 'invited',
        actorUserId: invitedByUserId,
        actorRole: 'agency',
        metadata: { inviteId: invite._id.toString(), email: normalized },
      });
    }

    return invite;
  }

  async listInvites(agencyId: string, status?: AgentInviteStatus) {
    const invites = await this.invites.listByAgency(agencyId, status);
    return invites.map((invite) => this.toInviteDto(invite));
  }

  async revokeInvite(agencyId: string, inviteId: string, actor: Actor) {
    const invite = await this.invites.findById(inviteId);
    if (!invite || invite.agency_id.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404);
    }

    const resolved = await this.invites.resolvePending(inviteId, 'revoked');
    if (!resolved) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }

    const agent = invite.email ? await this.agents.findByEmail(invite.email) : null;
    if (agent) {
      await this.events.append({
        membershipId: null,
        agentId: agent._id.toString(),
        agencyId,
        type: 'invite_revoked',
        actorUserId: actor.userId,
        actorRole: actor.role,
        metadata: { inviteId },
      });
    }

    return this.toInviteDto(resolved);
  }

  // ─── Agent side ───────────────────────────────────────────────────────────

  async listInvitesForAgent(agent: IDeliveryAgent) {
    if (!agent.email) return [];
    const invites = await this.invites.listPendingByEmail(agent.email);

    const agencyIds = [...new Set(invites.map((i) => i.agency_id.toString()))];
    const nameById = new Map<string, string>();
    await Promise.all(
      agencyIds.map(async (id) => {
        const agency = await this.agencies.findById(id);
        if (agency) nameById.set(id, agency.agency_name);
      })
    );

    return invites.map((invite) => ({
      ...this.toInviteDto(invite),
      agencyName: nameById.get(invite.agency_id.toString()) ?? null,
    }));
  }

  /**
   * Accept an invite → an approved membership.
   *
   * The invite is resolved AFTER the membership is created: if membership
   * creation fails (agency cap reached, duplicate), the invite must stay
   * pending so the agent can retry. Burning the invite first would strand them
   * with an offer they can no longer accept.
   */
  async acceptInvite(
    agent: IDeliveryAgent,
    inviteId: string,
    actor: Actor
  ): Promise<{ invite: ReturnType<AgentInviteService['toInviteDto']>; membership: IAgentAgencyMembership }> {
    const invite = await this.loadOwnPendingInvite(agent, inviteId);

    const membership = await this.contractService.createFromAcceptedInvite(
      agent._id.toString(),
      invite.agency_id.toString(),
      invite.invited_by_user_id?.toString() ?? null,
      invite.created_at,
      actor
    );

    const resolved = await this.invites.resolvePending(inviteId, 'accepted');

    return {
      invite: this.toInviteDto(resolved ?? invite),
      membership,
    };
  }

  async declineInvite(agent: IDeliveryAgent, inviteId: string, actor: Actor) {
    const invite = await this.loadOwnPendingInvite(agent, inviteId);
    const resolved = await this.invites.resolvePending(invite._id.toString(), 'declined');
    if (!resolved) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }

    await this.events.append({
      membershipId: null,
      agentId: agent._id.toString(),
      agencyId: invite.agency_id.toString(),
      type: 'invite_declined',
      actorUserId: actor.userId,
      actorRole: actor.role,
      metadata: { inviteId },
    });

    return this.toInviteDto(resolved);
  }

  private async loadOwnPendingInvite(agent: IDeliveryAgent, inviteId: string): Promise<IAgentInvite> {
    const invite = await this.invites.findById(inviteId);
    // Ownership by email match; report foreign invites as not found (no leaking).
    if (!invite || !agent.email || invite.email !== agent.email.toLowerCase()) {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404);
    }
    if (invite.status !== 'pending') {
      throw createAppError(ERROR_CODES.DELIVERY_INVITE_NOT_FOUND, 404, 'Invite is no longer pending');
    }
    return invite;
  }

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
}

export const agentInviteService = new AgentInviteService();
