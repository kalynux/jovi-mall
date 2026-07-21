import { ClientSession } from 'mongoose';
import {
  AgentMembershipEventModel,
  IAgentMembershipEvent,
  MembershipEventType,
} from '../models/agent-membership-event.model';
import { MembershipStatus } from '../models/agent-agency-membership.model';

export interface AppendEventInput {
  membershipId: string | null;
  agentId: string;
  agencyId: string;
  type: MembershipEventType;
  fromStatus?: MembershipStatus | null;
  toStatus?: MembershipStatus | null;
  actorUserId?: string | null;
  actorRole: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
}

/**
 * AgentMembershipEventRepository — append-only.
 *
 * There is intentionally no update or delete method. History that can be
 * rewritten is not history; a correction is a new event.
 */
export class AgentMembershipEventRepository {
  async append(input: AppendEventInput, session?: ClientSession): Promise<IAgentMembershipEvent> {
    const [event] = await AgentMembershipEventModel.create(
      [
        {
          membership_id: input.membershipId,
          agent_id: input.agentId,
          agency_id: input.agencyId,
          type: input.type,
          from_status: input.fromStatus ?? null,
          to_status: input.toStatus ?? null,
          actor_user_id: input.actorUserId ?? null,
          actor_role: input.actorRole,
          reason: input.reason ?? null,
          metadata: input.metadata ?? null,
          occurred_at: input.occurredAt ?? new Date(),
        },
      ],
      session ? { session } : {}
    );
    return event;
  }

  async listForAgent(agentId: string, limit = 100): Promise<IAgentMembershipEvent[]> {
    return await AgentMembershipEventModel.find({ agent_id: agentId })
      .sort({ occurred_at: -1 })
      .limit(limit);
  }

  async listForAgency(agencyId: string, limit = 100): Promise<IAgentMembershipEvent[]> {
    return await AgentMembershipEventModel.find({ agency_id: agencyId })
      .sort({ occurred_at: -1 })
      .limit(limit);
  }

  /** One agent's history within one agency — the dispute view. */
  async listForAgentInAgency(agentId: string, agencyId: string, limit = 100): Promise<IAgentMembershipEvent[]> {
    return await AgentMembershipEventModel.find({ agent_id: agentId, agency_id: agencyId })
      .sort({ occurred_at: -1 })
      .limit(limit);
  }

  async listForMembership(membershipId: string): Promise<IAgentMembershipEvent[]> {
    return await AgentMembershipEventModel.find({ membership_id: membershipId }).sort({ occurred_at: 1 });
  }
}

export const agentMembershipEventRepository = new AgentMembershipEventRepository();
