import type { NegotiationSessionStatus } from './negotiation-gate.rule';

/**
 * Is this `negotiation_record` call a RETRY of the turn that closed the deal?
 *
 * ── WHY THE GATE NEEDS TO KNOW ──────────────────────────────────────────────
 * The gate carries no idempotency key — the bargaining flow's HTTP call sends `X-Request-Id` and
 * nothing else — so a second submission of the closing turn used to be judged like any other
 * priced turn on a closed session: `revise`, `NEGOTIATION_SESSION_CLOSED`. That verdict is right
 * for a NEW price and wrong for a retry, and the difference reaches the customer:
 *
 *   - the flow's HTTP call timed out after the backend had committed, and the model (correctly)
 *     sent the same call again;
 *   - the flow echoes the LAST gate verdict per conversation, so the retry's `revise` overwrote the
 *     first call's `approved`, and `decide send` sent NOTHING — the customer who had just agreed a
 *     price got silence, or the main agent's unrelated answer.
 *
 * A replay answers `approved` again with the SAME lock, and the basket write is repeated — which is
 * safe because a cart add that presents a lock SETS the line rather than incrementing it. So a
 * retried close can never put the item in the basket twice, and it can repair a first call whose
 * basket write never happened.
 *
 * ── ⛔ DELIBERATELY NARROW ──────────────────────────────────────────────────
 * EXACTLY the closing turn: the same price, the same sentence, `lock: true`, on a deal this MODEL
 * closed, whose lock is still live and unspent. Every other submission is judged as before:
 *
 *   - a different price, or a different sentence, is a new turn on a closed deal → `revise`, and the
 *     instruction tells the agent the deal is done (the ledger keeps the sentence the customer was
 *     sent; approving a second one would put words in front of a customer the record never saw);
 *   - a deal the customer closed by PRESSING is not the model's to replay — its late turn is told
 *     "the customer has already accepted", which is the race design `offer-acceptance.service.ts`
 *     records;
 *   - a spent lock (an order exists) or a lapsed one has nothing left to replay.
 *
 * Pure: `now` is a parameter, like every rule in this module.
 */

export interface ReplaySessionView {
    status: NegotiationSessionStatus;
    lock: {
        closedBy: 'model' | 'button';
        unitPrice: number;
        expiresAt: Date;
        consumedAt: Date | null;
    } | null;
    /** The session's latest recorded turn, or null before the first. */
    lastTurn: {
        agentProposedPrice: number;
        lockRequested: boolean;
        reply: string;
    } | null;
}

export interface ReplayAttempt {
    agentProposedPrice: number;
    reply: string;
    lock: boolean;
}

export function isRecordReplay(session: ReplaySessionView, attempt: ReplayAttempt, now: Date): boolean {
    if (!attempt.lock) return false;
    if (session.status !== 'agreed') return false;

    const { lock, lastTurn } = session;
    if (!lock || lock.closedBy !== 'model') return false;
    if (lock.consumedAt !== null) return false;
    // `<=`, like every expiry on this path: a lock expiring this millisecond has expired.
    if (lock.expiresAt.getTime() <= now.getTime()) return false;

    if (!lastTurn || !lastTurn.lockRequested) return false;

    return (
        lastTurn.agentProposedPrice === attempt.agentProposedPrice
        && lock.unitPrice === attempt.agentProposedPrice
        && lastTurn.reply === attempt.reply
    );
}
