/**
 * Who has to agree when an appointment moves — the rules, with no I/O.
 *
 * Owner decisions 2026-10-26 (`PRODUCTION-READINESS/APPOINTMENT-LOCATION-AND-ACCESS-PLAN.md`):
 * - **D-9** — a VENDOR's move is a proposal; the customer accepts or declines it.
 * - **D-8** — a CUSTOMER's move applies at once (the vendor is told), EXCEPT on a `manual`-mode
 *   service, where the vendor chose to approve every booking by hand: there it is a proposal the
 *   vendor answers.
 *
 * While a proposal is open the booking keeps its original time, and the proposed one is held as
 * busy (`openProposalMatch` is in every occupancy query). No job runs: a proposal past `expiresAt`
 * reads as lapsed everywhere, because every query and every view compares the date itself.
 */

export type RescheduleActorRole = 'vendor' | 'customer';
export type BookingModeLike = 'calendar' | 'manual' | 'capacity' | string | null | undefined;

/** Whether a move by `actor` on a service in `mode` applies now or waits for the other side. */
export function rescheduleDecision(actor: RescheduleActorRole, mode: BookingModeLike): 'apply' | 'propose' {
    if (actor === 'vendor') return 'propose';
    return mode === 'manual' ? 'propose' : 'apply';
}

/** The side that answers a proposal made by `proposedBy`. */
export function answererOf(proposedBy: RescheduleActorRole): RescheduleActorRole {
    return proposedBy === 'vendor' ? 'customer' : 'vendor';
}

/**
 * When an unanswered proposal lapses: at the ORIGINAL start (D-9 — "no answer by the original
 * time, the original time stands"), or at the proposed start if that comes first, because a
 * proposal for a time that has already begun cannot be taken up.
 */
export function proposalExpiry(previousStartAt: Date, proposedStartAt: Date): Date {
    return new Date(Math.min(previousStartAt.getTime(), proposedStartAt.getTime()));
}

/**
 * The Mongo condition for "has an open proposal that still holds its time". Spread into a
 * `$match` / filter; `now` is passed so a test can pin the boundary.
 */
export function openProposalMatch(now: Date): Record<string, unknown> {
    return {
        'rescheduleProposal.status': 'open',
        'rescheduleProposal.expiresAt': { $gt: now },
    };
}

/** True when the booking has a proposal that is open and not yet expired. */
export function hasLiveProposal(
    p: { status: string; expiresAt: Date } | null | undefined,
    now: Date = new Date(),
): boolean {
    return !!p && p.status === 'open' && p.expiresAt.getTime() > now.getTime();
}

/**
 * D-9's second half: a customer who DECLINED the vendor's proposal may cancel with a full
 * refund whatever the cancellation policy says — the vendor started it. Only while that decline
 * is the latest word on the booking: a later proposal, accepted or not, replaces it.
 */
export function declinedVendorProposal(
    p: { status: string; proposedBy: string } | null | undefined,
): boolean {
    return !!p && p.status === 'declined' && p.proposedBy === 'vendor';
}
