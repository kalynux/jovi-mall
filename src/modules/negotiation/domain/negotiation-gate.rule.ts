import { ERROR_CODES } from '../../../core/error-codes';

/**
 * The gate — the one place a price proposed by the bargaining model is judged.
 *
 * ── What it does NOT do, and this is the whole design ────────────────────────
 *
 * It does not compute a price, a concession, a reserve, a "strategic last price"
 * or an "emergency rescue price". The MODEL decides all of that (plan D-2/D-9);
 * this refuses what falls outside the vendor's window and nothing else. Three
 * checks, listed in `BARGAINING-AGENT-PLAN.md` D-3:
 *
 *   1. the session is live
 *   2. `floor ≤ P ≤ ask`
 *   3. `P ≤ the previous counter on this line`
 *
 * Adding a fourth means changing D-3 with the owner, not editing this file.
 *
 * ── Pure, and deliberately so ────────────────────────────────────────────────
 *
 * No database, no clock of its own, no error factory. `now` is a parameter
 * because a rule that reads the wall clock cannot be tested at a boundary, and
 * every interesting case here IS a boundary — a price exactly at the floor,
 * exactly at the ask, exactly equal to the previous counter, a session expiring
 * this millisecond. It returns a verdict rather than throwing so the caller can
 * decide whether a refusal is an HTTP error (it is not — see `NegotiationService`,
 * which turns a refusal into a `revise` instruction the model acts on).
 *
 * ── The window is passed IN, never read here ─────────────────────────────────
 *
 * `floor` and `ask` must be re-read from the variant by the caller on every turn
 * (invariant 3). Snapshotting them at session open and judging against the
 * snapshot would let a vendor's price edit be exploited for the life of the
 * session; judging against a snapshot the vendor has since RAISED would let the
 * model sell below the floor the vendor now holds.
 */

/** Everything the decision needs. Nothing here is read from anywhere else. */
export interface GateInput {
    /** `variant.price` as it stands NOW. Per unit. */
    floor: number;
    /** `variant.bargain.maxPrice` as it stands NOW. Per unit. */
    ask: number;
    /** What the model wants to say. Per unit. */
    proposedPrice: number;
    /**
     * The last price this session quoted on this line, or null on the first turn.
     * Enforces the playbook's iron rule 1 — a seller who goes back up is not
     * bargaining, and a customer who sees it stops believing any number.
     */
    previousCounter: number | null;
    sessionStatus: NegotiationSessionStatus;
    sessionExpiresAt: Date;
    now: Date;
}

export type NegotiationSessionStatus = 'open' | 'agreed' | 'closed' | 'expired';

/** Why the gate refused. Maps 1:1 onto an error code; see `refusalCode`. */
export type GateRefusal =
    | 'session_closed'
    | 'session_expired'
    | 'below_floor'
    | 'above_ask'
    | 'price_increased';

export type GateVerdict =
    | { approved: true }
    | { approved: false; refusal: GateRefusal; details: Record<string, unknown> };

/**
 * Judge one proposed price.
 *
 * Order matters and is not arbitrary: session state first, because a price is
 * meaningless on a session that is over; then the window, because that is the
 * vendor's hard boundary; then the direction, which is a promise to the customer
 * rather than a limit. Reporting the first failure only is correct here — unlike
 * `AgentEligibilityService`, which reports every failed rule because a human is
 * reading it. Here a model is reading it and will re-draft, so one clear
 * instruction beats a list.
 */
export function judgeProposedPrice(input: GateInput): GateVerdict {
    const { floor, ask, proposedPrice, previousCounter, sessionStatus, sessionExpiresAt, now } = input;

    if (sessionStatus !== 'open') {
        return {
            approved: false,
            refusal: sessionStatus === 'expired' ? 'session_expired' : 'session_closed',
            details: { status: sessionStatus },
        };
    }

    // `<=` rather than `<`: a session whose expiry is exactly now has expired.
    if (sessionExpiresAt.getTime() <= now.getTime()) {
        return {
            approved: false,
            refusal: 'session_expired',
            details: { expiresAt: sessionExpiresAt.toISOString() },
        };
    }

    if (proposedPrice < floor) {
        // `details` carries the floor because the MODEL is the audience and it
        // already holds this number (D-2). It is never rendered to a customer —
        // `NegotiationService` returns a `revise` instruction, not an error body.
        return { approved: false, refusal: 'below_floor', details: { proposedPrice, floor } };
    }

    if (proposedPrice > ask) {
        return { approved: false, refusal: 'above_ask', details: { proposedPrice, ask } };
    }

    // Equality is allowed — holding at the same price is a legitimate move, and
    // the playbook's Margin Guardian stance is built on it.
    if (previousCounter !== null && proposedPrice > previousCounter) {
        return {
            approved: false,
            refusal: 'price_increased',
            details: { proposedPrice, previousCounter },
        };
    }

    return { approved: true };
}

/**
 * The error code a refusal corresponds to.
 *
 * Kept beside the rule rather than in the service so the mapping is total by
 * construction: a new `GateRefusal` member is a TypeScript error here, where a
 * `switch` in a service would have fallen through to a default and reported the
 * wrong thing.
 */
export const REFUSAL_CODES: Record<GateRefusal, string> = {
    session_closed: ERROR_CODES.NEGOTIATION_SESSION_CLOSED,
    session_expired: ERROR_CODES.NEGOTIATION_SESSION_EXPIRED,
    below_floor: ERROR_CODES.NEGOTIATION_PRICE_BELOW_FLOOR,
    above_ask: ERROR_CODES.NEGOTIATION_PRICE_ABOVE_ASK,
    price_increased: ERROR_CODES.NEGOTIATION_PRICE_INCREASED,
};

/**
 * A short instruction for the model, in English.
 *
 * ⚠ **This is not customer copy and must never be sent to one.** It goes back to
 * the sub-agent, which re-drafts and produces its own sentence in the customer's
 * language. Localising it would be localising an instruction nobody reads.
 */
export function reviseInstruction(refusal: GateRefusal, details: Record<string, unknown>): string {
    switch (refusal) {
        case 'below_floor':
            return `That price is below the minimum. Propose at least ${details.floor} and send it again.`;
        case 'above_ask':
            return `That price is above the asking price. Propose at most ${details.ask} and send it again.`;
        case 'price_increased':
            return `You already quoted ${details.previousCounter}. You cannot go back up — propose that or less.`;
        case 'session_expired':
            return 'This negotiation has expired. Start a new one before quoting a price.';
        case 'session_closed':
            return 'This negotiation is closed. Do not quote a price on it.';
    }
}
