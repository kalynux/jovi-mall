import {
    IAgentAgencyMembership,
    MembershipStatus,
    MembershipOrigin,
    IMembershipEmployment,
} from '../models/agent-agency-membership.model';
import { IAgentMembershipEvent, MembershipEventType } from '../models/agent-membership-event.model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface MembershipEmploymentDto {
    employmentType: IMembershipEmployment['employment_type'];
    employeeRef: string | null;
    startedAt: Date | null;
    endsAt: Date | null;
}

export interface AgentMembershipDto {
    id: string;
    agentId: string;
    agencyId: string;
    status: MembershipStatus;
    origin: MembershipOrigin;
    isPrimary: boolean;
    employment: MembershipEmploymentDto;
    /**
     * This agency's slice of the agent's global COD pool (minor units).
     * A sub-allocation, not an independent cap — see AgentCodThresholdService.
     */
    codThreshold: number;
    /** Cash the agent currently holds attributable to THIS contract. */
    codOutstandingBalance: number;
    invitedAt: Date | null;
    requestedAt: Date | null;
    approvedAt: Date | null;
    suspendedAt: Date | null;
    suspensionReason: string | null;
    removedAt: Date | null;
    removalReason: string | null;
    transferredToAgencyId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/** Membership plus the agency's display name, for the agent's portfolio view. */
export interface AgentMembershipWithAgencyDto extends AgentMembershipDto {
    agencyName: string | null;
}

export interface MembershipEventDto {
    id: string;
    membershipId: string | null;
    agentId: string;
    agencyId: string;
    type: MembershipEventType;
    fromStatus: MembershipStatus | null;
    toStatus: MembershipStatus | null;
    actorRole: string;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    occurredAt: Date;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AgentMembershipMapper {
    /**
     * SECURITY: actor user ids are deliberately omitted. An agency seeing which
     * admin user suspended an agent — or an agent seeing which agency staffer
     * removed them — leaks identity across a role boundary. The role is enough
     * to explain the action; the trail with ids stays admin-side.
     */
    static toDto(membership: IAgentAgencyMembership): AgentMembershipDto {
        return {
            id: membership._id.toString(),
            agentId: membership.agent_id.toString(),
            agencyId: membership.agency_id.toString(),
            status: membership.status,
            origin: membership.origin,
            isPrimary: membership.is_primary,
            employment: {
                employmentType: membership.employment?.employment_type ?? 'contractor',
                employeeRef: membership.employment?.employee_ref ?? null,
                startedAt: membership.employment?.started_at ?? null,
                endsAt: membership.employment?.ends_at ?? null,
            },
            codThreshold: membership.cod?.threshold ?? 0,
            codOutstandingBalance: membership.cod?.outstanding_balance ?? 0,
            invitedAt: membership.invited_at,
            requestedAt: membership.requested_at,
            approvedAt: membership.approved_at,
            suspendedAt: membership.suspended_at,
            suspensionReason: membership.suspension_reason,
            removedAt: membership.deactivated_at,
            removalReason: membership.deactivation_reason,
            transferredToAgencyId: membership.transferred_to_agency_id?.toString() ?? null,
            createdAt: membership.created_at,
            updatedAt: membership.updated_at,
        };
    }

    static toDtoWithAgency(
        membership: IAgentAgencyMembership,
        agencyName: string | null
    ): AgentMembershipWithAgencyDto {
        return { ...AgentMembershipMapper.toDto(membership), agencyName };
    }

    static toEventDto(event: IAgentMembershipEvent): MembershipEventDto {
        return {
            id: event._id.toString(),
            membershipId: event.membership_id?.toString() ?? null,
            agentId: event.agent_id.toString(),
            agencyId: event.agency_id.toString(),
            type: event.type,
            fromStatus: event.from_status,
            toStatus: event.to_status,
            actorRole: event.actor_role,
            reason: event.reason,
            metadata: event.metadata,
            occurredAt: event.occurred_at,
        };
    }
}
