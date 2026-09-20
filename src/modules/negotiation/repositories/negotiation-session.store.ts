import { Types } from 'mongoose';
import {
    INegotiationLock,
    INegotiationTurn,
    NegotiationSessionModel,
} from '../models/negotiation-session.model';

/**
 * The negotiation session's WRITES that can race — and the one guard every one of them uses.
 *
 * ── ⛔ WHY THIS FILE EXISTS: A DEAL NOW HAS TWO CLOSERS ───────────────────────
 * Until the **Lock it in** button, only the bargaining agent wrote to a session, one turn at a
 * time, and `NegotiationService.record` could load a session, change it and `save()` it. That
 * stopped being safe the moment a customer could close the deal by pressing a button while the
 * agent was mid-turn:
 *
 *     t0  the agent's turn loads the session            (open, round 3)
 *     t1  the customer presses Lock it in on round 3    → lock A written, status agreed
 *     t2  the agent's turn saves                        → round 4, lock B (or status open again)
 *
 * The basket holds lock A, which no session carries any more, and checkout refuses the line —
 * a deal the customer made, lost to a write they never saw. The schema has no optimistic
 * concurrency, so nothing noticed.
 *
 * So every write that moves a session out of `open`, or advances its round, is a
 * **compare-and-set on the state it was decided against**: the session must still be `open` and
 * still at the round the writer read. Exactly one writer wins; the loser matches nothing and
 * re-reads, and what it finds decides its answer — the agent is told the deal is already agreed,
 * a button press is told the offer has changed. Neither side is ever silently overwritten.
 *
 * ⚠ **`stillOpenAtRound` is THE guard, and every racing write must build its filter with it.**
 * A second hand-written filter is how one writer quietly stops checking the round. The suite scans
 * this file for that.
 */

/**
 * The filter every racing write uses: this customer's session, still open, still at `round`.
 *
 * ⚠ `customer_id` is in the filter as well as `_id`, so a write can never land on somebody else's
 * session even if an id were guessed — the same scoping every read here already applies.
 */
export function stillOpenAtRound(sessionId: string, customerId: string, round: number) {
    return {
        _id: new Types.ObjectId(sessionId),
        customer_id: new Types.ObjectId(customerId),
        status: 'open' as const,
        round,
        deletedAt: null,
    };
}

/** One model turn, as `record` has already judged and composed it. */
export interface ApprovedTurnWrite {
    turn: INegotiationTurn;
    /** The price just quoted, which becomes the session's current counter. */
    counter: number;
    /** Written only when the customer named a number this turn. */
    customerOffer?: number;
    /** Present when the model asked for the deal to be locked on this turn. */
    lock?: INegotiationLock;
}

export class NegotiationSessionStore {
    /**
     * Record one approved model turn — only if nothing else has moved the session since `record`
     * read it. Answers whether it was written.
     *
     * A turn that locks also moves the status to `agreed` in the SAME write, so there is no instant
     * at which a lock exists on an open session.
     */
    async appendTurnIfStillOpen(
        sessionId: string,
        customerId: string,
        readAtRound: number,
        write: ApprovedTurnWrite,
    ): Promise<boolean> {
        const set: Record<string, unknown> = {
            round: readAtRound + 1,
            current_counter: write.counter,
        };
        if (write.customerOffer !== undefined) set.last_customer_offer = write.customerOffer;
        if (write.lock) {
            set.lock = write.lock;
            set.status = 'agreed';
        }

        const result = await NegotiationSessionModel.updateOne(
            stillOpenAtRound(sessionId, customerId, readAtRound),
            { $set: set, $push: { turns: write.turn } },
        );
        return result.matchedCount === 1;
    }

    /**
     * Close the deal on a customer's press — only if the session is still open at the round the
     * button named. Answers whether THIS call closed it.
     *
     * ⚠ **This is what makes "one lock, one spend" true for a double tap.** Two presses both decide
     * `lock_now`; one of them matches, the other matches nothing, re-reads, finds the first one's
     * lock and spends THAT. A second lock is never minted.
     */
    async lockIfStillOpen(
        sessionId: string,
        customerId: string,
        round: number,
        lock: INegotiationLock,
    ): Promise<boolean> {
        const result = await NegotiationSessionModel.updateOne(
            stillOpenAtRound(sessionId, customerId, round),
            { $set: { lock, status: 'agreed' } },
        );
        return result.matchedCount === 1;
    }

    /**
     * Write down an expiry somebody discovered by reading — only if the session is still open at the
     * round it was read at.
     *
     * ⚠ **Guarded like the other two, and it matters more than it looks.** An unguarded
     * `status: 'expired'` landing a moment after a press closed the deal would re-label an agreed
     * session, and `context` would then stop reporting it as agreed — so the agent would reopen a
     * haggle the customer had already closed. Best-effort: a miss means somebody else has already
     * moved the session on, which is the answer the expiry was trying to record anyway.
     */
    async markExpiredIfStillOpen(sessionId: string, customerId: string, round: number): Promise<void> {
        await NegotiationSessionModel.updateOne(stillOpenAtRound(sessionId, customerId, round), {
            $set: { status: 'expired' },
        });
    }
}

export const negotiationSessionStore = new NegotiationSessionStore();
