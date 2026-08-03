import {
    IContractStatusRequest,
    ContractTransition,
    StatusRequestState,
    ContractParty,
} from '../models/contract-status-request.model';
import { ContractStatus } from '../models/agent-agency-membership.model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

/**
 * What the VIEWER may do with this request, derived server-side.
 *
 * `approve`/`reject` map to `POST …/status-requests/:id/resolve`, `cancel` to
 * `POST …/status-requests/:id/cancel`. An empty array means the row is
 * informational — it is already resolved, and neither verb applies.
 */
export type ContractStatusRequestAction = 'approve' | 'reject' | 'cancel';

/**
 * Who is reading the row. Narrower than `ContractParty` on purpose: that union
 * also carries `admin` and `system`, and neither is a party to the consent this
 * DTO describes — an admin viewer would otherwise be told it may `approve` a
 * request that `resolveRequestAs` only accepts from the two contract parties.
 */
export type ContractStatusRequestViewer = 'agent' | 'agency';

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
    /**
     * True when this request is pending and the VIEWER is the party who must
     * answer it — i.e. the counterparty raised it.
     *
     * Both inbox endpoints deliberately return each party's pending requests in
     * BOTH directions: the list is the only place a client can learn the id of a
     * request it raised itself, which it needs in order to cancel one. That makes
     * "is this mine to answer?" a question every client would otherwise re-derive
     * from `requestedByRole`, and one that is easy to get wrong — the symptom
     * being a self-raised removal rendered as "wants to leave / Approve", whose
     * Approve then 403s. It is computed here instead, from the same rule the
     * service guards enforce.
     *
     * It is also the correct predicate for an unread badge: counting rows rather
     * than rows where this is true over-counts by every request you raised.
     */
    awaitingMyDecision: boolean;
    /** The verbs the viewer may actually call on this row, in render order. */
    availableActions: ContractStatusRequestAction[];
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
     *
     * `viewerRole` is REQUIRED, not defaulted: `awaitingMyDecision` is meaningless
     * without a viewer, and a default would silently answer for the wrong party.
     * Note this makes the mapper unsafe to pass bare to `Array.prototype.map`,
     * which would supply the index as the second argument — call sites pass an
     * arrow.
     */
    static toDto(
        request: IContractStatusRequest,
        viewerRole: ContractStatusRequestViewer
    ): ContractStatusRequestDto {
        // Mirrors the two service guards exactly: `resolveRequestAs` refuses the
        // requester, `cancelRequestAs` refuses everyone else, and both require
        // `pending`. If those guards ever change, change this with them — a
        // button this DTO offers must be one the service will accept.
        const pending = request.state === 'pending';
        const mine = request.requested_by_role === viewerRole;

        const awaitingMyDecision = pending && !mine;
        const availableActions: ContractStatusRequestAction[] = !pending
            ? []
            : mine
              ? ['cancel']
              : ['approve', 'reject'];

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
            awaitingMyDecision,
            availableActions,
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
