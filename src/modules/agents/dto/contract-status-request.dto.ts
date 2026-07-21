import {
    IContractStatusRequest,
    ContractTransition,
    StatusRequestState,
    ContractParty,
} from '../models/contract-status-request.model';
import { ContractStatus } from '../models/agent-agency-membership.model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface ContractStatusRequestDto {
    id: string;
    contractId: string;
    agentId: string;
    agencyId: string;
    transition: ContractTransition;
    /** Where the contract lands if this is approved. */
    targetStatus: ContractStatus;
    fromStatus: ContractStatus;
    state: StatusRequestState;
    requestedByRole: ContractParty;
    reason: string | null;
    resolvedByRole: ContractParty | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    /**
     * Why a pending deactivation cannot proceed yet — e.g.
     * `{ outstandingCod: 50000, outstandingPayment: 0 }`. Null when nothing is
     * in the way. Lets a UI explain "waiting on cash return" without
     * re-deriving the rule.
     */
    blockingConditions: Record<string, unknown> | null;
    /** True when the initiator held unilateral authority and it self-cleared. */
    autoApproved: boolean;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class ContractStatusRequestMapper {
    /**
     * SECURITY: actor user ids are omitted, matching AgentMembershipMapper — an
     * agency seeing which agent user raised a request, or an agent seeing which
     * agency staffer resolved one, leaks identity across a role boundary. The
     * role explains the action; the trail with ids stays admin-side.
     */
    static toDto(request: IContractStatusRequest): ContractStatusRequestDto {
        return {
            id: request._id.toString(),
            contractId: request.contract_id.toString(),
            agentId: request.agent_id.toString(),
            agencyId: request.agency_id.toString(),
            transition: request.transition,
            targetStatus: request.target_status,
            fromStatus: request.from_status,
            state: request.state,
            requestedByRole: request.requested_by_role,
            reason: request.reason,
            resolvedByRole: request.resolved_by_role,
            resolvedAt: request.resolved_at,
            resolutionNote: request.resolution_note,
            blockingConditions: request.blocking_conditions,
            autoApproved: request.auto_approved,
            createdAt: request.created_at,
            updatedAt: request.updated_at,
        };
    }
}
