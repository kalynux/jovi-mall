import { judgeLock } from './lock-verdict.rule';
import { judgeProposedPrice, NegotiationSessionStatus } from './negotiation-gate.rule';

/**
 * What a press on **Lock it in** may do — the whole of the decision, as a pure function.
 *
 * ── WHY A BUTTON MAY CLOSE A DEAL AT ALL ────────────────────────────────────
 * The rule this module was built on is "the backend never infers a close from the wording": a
 * customer typing "ok" is not a yes the platform may act on, because words are ambiguous in five
 * languages and a price is money. That rule stands. What changed (owner, 2026-09-16) is that a
 * close may also come from an **explicit, priced button** — "Lock it in · 18 000 XAF" under the
 * agent's own offer. A press on that is not inference; it is the customer choosing the one thing
 * the button says.
 *
 * So the rule now reads: **a deal closes by the model's call, or by an explicit priced button —
 * never by inferring a yes from free text.**
 *
 * ── ⛔ THE BUTTON CARRIES A REFERENCE, NEVER A PRICE ──────────────────────────
 * The token is `deal:<sessionId>:<round>`. The price is the session's own record of that round's
 * offer, and it is re-judged here against the vendor's window AS IT STANDS NOW, with the same
 * `judgeProposedPrice` the gate uses. A token carrying a price would let anybody who can send a
 * callback lock any figure; a token carrying a round makes "the exact price shown" true, because a
 * press on an offer the agent has since replaced is answered `superseded` rather than locked at a
 * price the customer never saw.
 *
 * ── WHY THE PRESSED ROUND MUST BE THE LATEST ────────────────────────────────
 * The gate refuses every turn once a session is no longer `open`, so a session's lock — whoever
 * minted it — always belongs to its LATEST round. A press on round 3 of a session now at round 4
 * is therefore a press on an offer that no longer stands, whether round 4 is a newer counter or a
 * deal the model has since closed.
 *
 * ── Pure ─────────────────────────────────────────────────────────────────────
 * No database, no clock of its own, no error factory — `now` and the window are passed in. The
 * I/O, including the compare-and-set that makes a double tap lock once, is
 * `services/offer-acceptance.service.ts`.
 */

/** The session as this decision needs it. Field names are the domain's, not the document's. */
export interface OfferSessionView {
    status: NegotiationSessionStatus;
    /** The latest round recorded. 0 means the agent has not offered anything yet. */
    round: number;
    /** The agent's latest offer, per unit. Null before its first turn. */
    currentCounter: number | null;
    offers: ReadonlyArray<{ round: number; agentProposedPrice: number }>;
    expiresAt: Date;
    customerId: string;
    variantId: string;
    quantity: number;
    lock: { unitPrice: number; expiresAt: Date; consumedAt: Date | null } | null;
}

/**
 * The vendor's window as it stands now, or why there is none.
 *
 * `gone` separates two absences that deserve different sentences: a product taken off sale
 * (`gone: true` — there is nothing to talk about) and a variant whose bargaining window was
 * cleared (`gone: false` — the price moved, which the customer can be told and asked about).
 */
export type OfferWindowRead =
    | { ok: true; floor: number; ask: number }
    | { ok: false; gone: boolean };

export type OfferDecision =
    /** Mint a lock at this price — if the session is still open at this round when written. */
    | { kind: 'lock_now'; unitPrice: number }
    /** A lock for this offer already exists and is still good: spend THAT one, never a second. */
    | { kind: 'reuse_lock' }
    /** The pressed offer was replaced. The latest one is offered back, with its own button. */
    | { kind: 'superseded'; latestRound: number; latestPrice: number }
    /** The agreed price was already spent by an order. */
    | { kind: 'already_ordered' }
    /** The offer, or the agreed price, ran out. `markExpired` = write the status down. */
    | { kind: 'expired'; markExpired: boolean }
    /** The vendor's window moved since the offer; the price no longer stands. */
    | { kind: 'price_changed' }
    /** Nothing this customer can act on — an unknown round, a product off sale, a bad ledger. */
    | { kind: 'unavailable' };

export interface OfferAcceptanceInput {
    session: OfferSessionView;
    pressedRound: number;
    window: OfferWindowRead;
    now: Date;
}

export function decideOfferAcceptance(input: OfferAcceptanceInput): OfferDecision {
    const { session, pressedRound, window, now } = input;

    /**
     * A round this service never drew a button for. Round 0 has no offer; a round beyond the
     * session's latest was never minted by us. Both are the same answer as an unknown session.
     */
    if (!Number.isInteger(pressedRound) || pressedRound < 1 || pressedRound > session.round) {
        return { kind: 'unavailable' };
    }

    if (session.lock) {
        /**
         * Spent before anything else, for `judgeLock`'s reason: "already ordered" is the more
         * useful fact, and "that offer changed" or "it ran out" would invite a second purchase
         * of something the customer has already bought.
         */
        if (session.lock.consumedAt !== null) return { kind: 'already_ordered' };

        if (pressedRound < session.round) {
            return { kind: 'superseded', latestRound: session.round, latestPrice: session.lock.unitPrice };
        }

        if (!window.ok && window.gone) return { kind: 'unavailable' };

        /**
         * ⚠ **The existing lock is judged by the SAME rule checkout will judge it by**, presented
         * for exactly its own binding. So a press can never add a line that checkout would then
         * refuse — the two answers are one function's.
         */
        const verdict = judgeLock({
            lock: {
                unit_price: session.lock.unitPrice,
                expires_at: session.lock.expiresAt,
                consumed_at: session.lock.consumedAt,
            },
            binding: {
                customerId: session.customerId,
                variantId: session.variantId,
                quantity: session.quantity,
            },
            presented: {
                customerId: session.customerId,
                variantId: session.variantId,
                quantity: session.quantity,
            },
            window: window.ok ? { floor: window.floor, ask: window.ask } : null,
            now,
        });

        if (verdict.ok) return { kind: 'reuse_lock' };
        switch (verdict.reason) {
            case 'consumed':
                return { kind: 'already_ordered' };
            case 'expired':
                return { kind: 'expired', markExpired: false };
            case 'window_moved':
                return { kind: 'price_changed' };
            default:
                // `not_found` and `mismatch` cannot arise for a lock presented for its own
                // binding. Refusing is the right answer if they ever do; guessing is not.
                return { kind: 'unavailable' };
        }
    }

    /**
     * No lock. `agreed` and `closed` both imply one, so either without it is a ledger this
     * service did not write — refused rather than repaired on a customer's press.
     */
    if (session.status === 'agreed' || session.status === 'closed') return { kind: 'unavailable' };
    if (session.status === 'expired') return { kind: 'expired', markExpired: false };

    if (pressedRound < session.round) {
        if (session.currentCounter === null) return { kind: 'unavailable' };
        return { kind: 'superseded', latestRound: session.round, latestPrice: session.currentCounter };
    }

    /**
     * ⛔ **The price is READ from the ledger, and the ledger must agree with itself.** The round's
     * recorded offer and the session's current counter are two records of one number; if they
     * disagree, which one the customer saw is unknowable, and a lock at either could be a price
     * they never agreed to.
     */
    const offered = session.offers.find((offer) => offer.round === pressedRound)?.agentProposedPrice;
    if (offered === undefined || offered !== session.currentCounter) return { kind: 'unavailable' };

    if (!window.ok) return window.gone ? { kind: 'unavailable' } : { kind: 'price_changed' };

    /**
     * ⭐ **The gate's own rule, with the gate's own inputs** — the live window, the session's
     * status and expiry, and the current counter as the previous one (equality is allowed, so
     * accepting the standing offer passes the non-increasing check by construction).
     */
    const verdict = judgeProposedPrice({
        floor: window.floor,
        ask: window.ask,
        proposedPrice: offered,
        previousCounter: session.currentCounter,
        sessionStatus: session.status,
        sessionExpiresAt: session.expiresAt,
        now,
    });

    if (verdict.approved) return { kind: 'lock_now', unitPrice: offered };
    switch (verdict.refusal) {
        case 'session_expired':
            return { kind: 'expired', markExpired: true };
        case 'below_floor':
        case 'above_ask':
            return { kind: 'price_changed' };
        default:
            return { kind: 'unavailable' };
    }
}
