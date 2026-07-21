import { AgentInviteModel, IAgentInvite, AgentInviteStatus } from '../models/agent-invite.model';

export class AgentInviteRepository {
  async create(data: {
    agency_id: string;
    email: string;
    invited_by_user_id: string;
  }): Promise<IAgentInvite> {
    return await AgentInviteModel.create(data);
  }

  async findById(inviteId: string): Promise<IAgentInvite | null> {
    return await AgentInviteModel.findById(inviteId);
  }

  async findPendingByAgencyAndEmail(agencyId: string, email: string): Promise<IAgentInvite | null> {
    return await AgentInviteModel.findOne({
      agency_id: agencyId,
      email: email.toLowerCase(),
      status: 'pending',
    });
  }

  async listByAgency(agencyId: string, status?: AgentInviteStatus): Promise<IAgentInvite[]> {
    const filter: Record<string, unknown> = { agency_id: agencyId };
    if (status) filter.status = status;
    return await AgentInviteModel.find(filter).sort({ created_at: -1 });
  }

  async listPendingByEmail(email: string): Promise<IAgentInvite[]> {
    return await AgentInviteModel.find({ email: email.toLowerCase(), status: 'pending' }).sort({
      created_at: -1,
    });
  }

  /**
   * Atomically resolve a pending invite (accept/decline/revoke). Returns null
   * when the invite was already resolved — callers treat that as a conflict.
   */
  async resolvePending(
    inviteId: string,
    status: Exclude<AgentInviteStatus, 'pending'>
  ): Promise<IAgentInvite | null> {
    return await AgentInviteModel.findOneAndUpdate(
      { _id: inviteId, status: 'pending' },
      { status, responded_at: new Date() },
      { new: true }
    );
  }
}
