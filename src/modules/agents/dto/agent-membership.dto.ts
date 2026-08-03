import {
    IAgentAgencyMembership,
    MembershipStatus,
    MembershipOrigin,
    IMembershipEmployment,
    IContractRemittanceTerms,
    IContractCoverage,
    IContractFeeSplit,
    contractDefaults,
} from '../models/agent-agency-membership.model';
import { IAgentMembershipEvent, MembershipEventType } from '../models/agent-membership-event.model';
import { IPolygon } from '../../../core/types/geo.types';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface MembershipEmploymentDto {
    employmentType: IMembershipEmployment['employment_type'];
    employeeRef: string | null;
    startedAt: Date | null;
    endsAt: Date | null;
}

/**
 * How often the agent settles this agency's COD cash. Mirrors
 * `remittance_terms` on the contract — the group `PATCH …/terms` writes under
 * that key, so a client can round-trip what it reads.
 */
export interface MembershipRemittanceTermsDto {
    cadence: IContractRemittanceTerms['cadence'];
    /** 0=Sunday … 6=Saturday, for weekly/biweekly. null otherwise. */
    dayOfWeek: number | null;
    /** 1–28, for monthly. null otherwise. */
    dayOfMonth: number | null;
    graceHours: number;
}

/** This contract's operating zone — a subset of the agent's own service area. */
export interface MembershipCoverageDto {
    regions: string[];
    /** GeoJSON, as stored — the same shape `PATCH …/terms` accepts. */
    area: IPolygon | null;
}

/**
 * The commission arrangement. Exposed to BOTH parties deliberately: this is what
 * the earnings split divides by at delivery, and an agent may not be shown a
 * balance whose derivation they cannot see.
 */
export interface MembershipFeeSplitDto {
    model: IContractFeeSplit['model'];
    /** 0–100. Meaningful when `model` is 'percentage'. */
    agentSharePercent: number | null;
    /** Minor units. Meaningful when `model` is 'flat'. */
    agentFlatFee: number | null;
    currency: string;
}

export interface AgentMembershipDto {
    id: string;
    agentId: string;
    agencyId: string;
    status: MembershipStatus;
    origin: MembershipOrigin;
    /**
     * Which party raised this contract, derived from `origin`. Only
     * `join_request` is agent-raised; every other origin is agency- or
     * platform-raised.
     *
     * **Audit, not the button rule.** It used to be both, back when terms could
     * not change after creation. Now a counter moves the right to approve to the
     * other side while `origin` stays put, so a client rendering buttons from
     * this field would offer Approve to the party who just made the offer. Use
     * `awaitingDecisionFrom`.
     */
    initiatedBy: 'agent' | 'agency';
    /**
     * Which party made the terms currently standing, or null if no party has
     * stated any yet (a bare join request, or a legacy row whose fee split was
     * never configured).
     */
    termsProposedBy: 'agent' | 'agency' | null;
    /** Bumped on every counter and every accepted proposal. 0 = never stated. */
    termsVersion: number;
    /**
     * **This is what a client renders the pending-state buttons from.**
     *
     * The party who must answer the standing offer: they see Approve / Reject /
     * Counter, and the other party sees Withdraw. Null in two cases, and the
     * difference matters to the UI:
     *
     *  - the contract is not `pending` — there is no offer on the table;
     *  - `termsProposedBy` is null — nobody has proposed terms, so nobody may
     *    approve. The agency's control here is "Propose terms", not "Approve".
     *
     * Derived from the same rule the server enforces
     * (AgentContractService.proposerOf + assertTermsApprovable).
     */
    awaitingDecisionFrom: 'agent' | 'agency' | null;
    /**
     * The open terms proposal on this LIVE contract, if the caller loaded one.
     * Null when there is none — or when the endpoint does not resolve proposals,
     * which most do not. Never treat null as proof that none exists; the
     * proposals endpoints are authoritative.
     */
    openTermsProposalId: string | null;
    isPrimary: boolean;

    // ── Negotiated terms ─────────────────────────────────────────────────────
    //
    // Everything `PATCH /api/agency/agents/:id/terms` writes is read back here,
    // key for key (camelCased). A terms editor that cannot read the current
    // values can only ever write blind, and a partial PATCH would then be
    // indistinguishable from a full one. Both parties see them — the terms are
    // the contract, not the agency's private configuration.
    employment: MembershipEmploymentDto;
    remittanceTerms: MembershipRemittanceTermsDto;
    coverage: MembershipCoverageDto;
    feeSplit: MembershipFeeSplitDto;
    /**
     * Cap on the value of a SINGLE shipment this agency will assign under this
     * contract, independent of the COD threshold. null = no per-shipment cap.
     */
    shipmentValueCeiling: number | null;
    /**
     * This agency's slice of the agent's global COD pool (minor units).
     * A sub-allocation, not an independent cap — see AgentCodThresholdService.
     * Written by `PATCH …/cod-limit`, not by `PATCH …/terms`.
     */
    codThreshold: number;
    /** Cash the agent currently holds attributable to THIS contract. */
    codOutstandingBalance: number;
    invitedAt: Date | null;
    requestedAt: Date | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
    withdrawnAt: Date | null;
    withdrawalReason: string | null;
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
    static toDto(
        membership: IAgentAgencyMembership,
        openTermsProposalId: string | null = null
    ): AgentMembershipDto {
        // Contracts written before a terms group existed can be missing its
        // sub-document entirely, so each group falls back to the same defaults
        // the schema applies on write — never to `null`, which a form would
        // render as "unset" for a term the server actually enforces.
        const remittance = membership.remittance_terms ?? contractDefaults.remittanceTerms();
        const coverage = membership.coverage ?? contractDefaults.coverage();
        const feeSplit = membership.fee_split ?? contractDefaults.feeSplit();

        const initiatedBy: 'agent' | 'agency' =
            membership.origin === 'join_request' ? 'agent' : 'agency';
        const termsProposedBy = membership.terms_proposed_by ?? null;

        // Mirrors proposerOf + assertTermsApprovable: with no terms proposed
        // nobody may approve, so nobody is awaiting a decision — the agency owes
        // a proposal, not an answer.
        const awaitingDecisionFrom: 'agent' | 'agency' | null =
            membership.status !== 'pending' || termsProposedBy === null
                ? null
                : termsProposedBy === 'agent'
                  ? 'agency'
                  : 'agent';

        return {
            id: membership._id.toString(),
            agentId: membership.agent_id.toString(),
            agencyId: membership.agency_id.toString(),
            status: membership.status,
            origin: membership.origin,
            initiatedBy,
            termsProposedBy,
            termsVersion: membership.terms_version ?? 0,
            awaitingDecisionFrom,
            openTermsProposalId,
            isPrimary: membership.is_primary,
            employment: {
                employmentType: membership.employment?.employment_type ?? 'contractor',
                employeeRef: membership.employment?.employee_ref ?? null,
                startedAt: membership.employment?.started_at ?? null,
                endsAt: membership.employment?.ends_at ?? null,
            },
            remittanceTerms: {
                cadence: remittance.cadence ?? 'daily',
                dayOfWeek: remittance.day_of_week ?? null,
                dayOfMonth: remittance.day_of_month ?? null,
                graceHours: remittance.grace_hours ?? 24,
            },
            coverage: {
                regions: coverage.regions ?? [],
                area: coverage.area ?? null,
            },
            feeSplit: {
                model: feeSplit.model ?? 'percentage',
                agentSharePercent: feeSplit.agent_share_percent ?? null,
                agentFlatFee: feeSplit.agent_flat_fee ?? null,
                currency: feeSplit.currency ?? 'XAF',
            },
            shipmentValueCeiling: membership.shipment_value_ceiling ?? null,
            codThreshold: membership.cod?.threshold ?? 0,
            codOutstandingBalance: membership.cod?.outstanding_balance ?? 0,
            invitedAt: membership.invited_at,
            requestedAt: membership.requested_at,
            approvedAt: membership.approved_at,
            rejectedAt: membership.rejected_at,
            rejectionReason: membership.rejection_reason,
            withdrawnAt: membership.withdrawn_at,
            withdrawalReason: membership.withdrawal_reason,
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
