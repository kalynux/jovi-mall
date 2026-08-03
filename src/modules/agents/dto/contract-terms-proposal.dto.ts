import {
    IContractTermsProposal,
    TermsProposalState,
    ProposedTerms,
} from '../models/contract-terms-proposal.model';
import {
    ContractTermsParty,
    AGENT_NEGOTIABLE_TERM_GROUPS,
} from '../models/agent-agency-membership.model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

/**
 * What the VIEWER may do with this proposal, derived server-side.
 *
 * `approve`/`reject` map to `POST …/terms-proposals/:id/resolve`, `counter` to
 * `…/counter`, `cancel` to `…/cancel`. An empty array means the row is
 * informational — already resolved, and no verb applies.
 */
export type TermsProposalAction = 'approve' | 'reject' | 'counter' | 'cancel';

/**
 * Who is reading the row. Narrower than the model's role union by intent —
 * only the two contract parties are party to this consent.
 */
export type TermsProposalViewer = ContractTermsParty;

/** One changed leaf, addressed by its dotted path within the term groups. */
export interface TermsDiffEntry {
    /** e.g. `fee_split.agent_share_percent`, `coverage.regions`. */
    path: string;
    before: unknown;
    after: unknown;
}

export interface ContractTermsProposalDto {
    id: string;
    contractId: string;
    agentId: string;
    agencyId: string;
    proposedByRole: ContractTermsParty;
    state: TermsProposalState;
    /**
     * True when this proposal is pending and the VIEWER is the party who must
     * answer it.
     *
     * Both inbox endpoints return each party's pending proposals in BOTH
     * directions — the list is the only place a client learns the id of a
     * proposal it raised itself, which it needs in order to cancel one. That
     * makes "is this mine to answer?" a question every client would otherwise
     * re-derive, and get wrong. Also the correct predicate for an unread badge:
     * counting rows over-counts by every proposal you raised.
     */
    awaitingMyDecision: boolean;
    availableActions: TermsProposalAction[];
    /** The agreed terms when this was raised — not the contract's terms now. */
    termsBefore: ProposedTerms;
    proposedTerms: ProposedTerms;
    /** Flattened before→after, so a client renders a diff without walking. */
    diff: TermsDiffEntry[];
    /** The proposal this one counters, if any. */
    supersedesId: string | null;
    note: string | null;
    resolvedByRole: ContractTermsParty | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Structural equality for the scalar/array leaves terms are made of. */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => sameValue(v, b[i]));
    }
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (typeof a === 'object' && typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
}

/**
 * Flatten `before` → `after` into one entry per CHANGED leaf.
 *
 * Walks only one level into each term group, which is exactly how deep the
 * groups go: `fee_split.model`, `coverage.regions`, `remittance_terms.cadence`.
 * `shipment_value_ceiling` is a scalar group and yields its own bare path.
 *
 * Only keys present in `after` are considered — a proposal is a PATCH, and a
 * group it does not mention is not being changed. Unchanged leaves are dropped,
 * so a proposal that restates the current value renders as an empty diff rather
 * than as noise, and a client can honestly show "no effective change".
 *
 * Pure and DB-free so the ts-node harness can cover it.
 */
export function diffTerms(before: ProposedTerms, after: ProposedTerms): TermsDiffEntry[] {
    const entries: TermsDiffEntry[] = [];

    for (const [group, proposed] of Object.entries(after ?? {})) {
        if (proposed === undefined) continue;
        const current = (before ?? {})[group];

        const isNested =
            proposed !== null && typeof proposed === 'object' && !Array.isArray(proposed);

        if (!isNested) {
            if (!sameValue(current, proposed)) {
                entries.push({ path: group, before: current ?? null, after: proposed });
            }
            continue;
        }

        const currentGroup =
            current !== null && typeof current === 'object' && !Array.isArray(current)
                ? (current as Record<string, unknown>)
                : {};

        for (const [key, value] of Object.entries(proposed as Record<string, unknown>)) {
            if (value === undefined) continue;
            const was = currentGroup[key];
            if (!sameValue(was, value)) {
                entries.push({ path: `${group}.${key}`, before: was ?? null, after: value });
            }
        }
    }

    return entries;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class ContractTermsProposalMapper {
    /**
     * SECURITY: actor user ids are omitted, matching AgentMembershipMapper and
     * ContractStatusRequestMapper — the role explains the action; the trail with
     * ids stays admin-side.
     *
     * `viewerRole` is REQUIRED, not defaulted: `awaitingMyDecision` is
     * meaningless without a viewer, and a default would answer for the wrong
     * party. That makes this mapper unsafe to pass bare to
     * `Array.prototype.map`, which supplies the index as the second argument —
     * call sites pass an arrow.
     */
    static toDto(
        proposal: IContractTermsProposal,
        viewerRole: TermsProposalViewer
    ): ContractTermsProposalDto {
        // Mirrors the three service guards exactly: `resolveTermsProposalAs` and
        // `counterTermsProposalAs` refuse the author, `cancelTermsProposalAs`
        // refuses everyone else, and all three require `pending`. A button this
        // DTO offers must be one the service will accept.
        const pending = proposal.state === 'pending';
        const mine = proposal.proposed_by_role === viewerRole;

        const proposed = (proposal.proposed_terms ?? {}) as ProposedTerms;

        // An agent may only counter with groups they are allowed to author. A
        // proposal touching only agency-reserved groups (a cadence change, say)
        // is answerable but not counterable by them — offering Counter there
        // would render a button whose every body 403s.
        const agentMayCounter = Object.keys(proposed).every((group) =>
            (AGENT_NEGOTIABLE_TERM_GROUPS as readonly string[]).includes(group)
        );
        const mayCounter = viewerRole === 'agency' || agentMayCounter;

        const availableActions: TermsProposalAction[] = !pending
            ? []
            : mine
              ? ['cancel']
              : mayCounter
                ? ['approve', 'reject', 'counter']
                : ['approve', 'reject'];

        return {
            id: proposal._id.toString(),
            contractId: proposal.contract_id.toString(),
            agentId: proposal.agent_id.toString(),
            agencyId: proposal.agency_id.toString(),
            proposedByRole: proposal.proposed_by_role,
            state: proposal.state,
            awaitingMyDecision: pending && !mine,
            availableActions,
            termsBefore: (proposal.terms_before ?? {}) as ProposedTerms,
            proposedTerms: proposed,
            diff: diffTerms((proposal.terms_before ?? {}) as ProposedTerms, proposed),
            supersedesId: proposal.supersedes_id?.toString() ?? null,
            note: proposal.note,
            resolvedByRole: proposal.resolved_by_role,
            resolvedAt: proposal.resolved_at,
            resolutionNote: proposal.resolution_note,
            createdAt: proposal.created_at,
            updatedAt: proposal.updated_at,
        };
    }
}
