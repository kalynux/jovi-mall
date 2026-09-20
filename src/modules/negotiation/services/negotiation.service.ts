import crypto from 'crypto';
import { Types } from 'mongoose';

import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botIdentityService } from '../../bot-surface/services/bot-identity.service';
import { NEGOTIATION_CONFIG } from '../config/negotiation.config';
import {
    GateRefusal,
    REFUSAL_CODES,
    judgeProposedPrice,
    reviseInstruction,
} from '../domain/negotiation-gate.rule';
import {
    INegotiationSession,
    NegotiationLockCloser,
    NegotiationSessionModel,
} from '../models/negotiation-session.model';
import { negotiationProfileRepository } from '../repositories/negotiation-profile.repository';
import { negotiationSessionStore } from '../repositories/negotiation-session.store';
import { NegotiationContextInput, NegotiationRecordInput } from '../validators/negotiation.validator';
/** The live window, read fresh on every turn. Never a snapshot — see invariant 3. */
import { LiveWindow, liveWindowReader } from './live-window.reader';
import {
    acceptOffer,
    AcceptOfferInput,
    AcceptOfferOutcome,
    MONGO_OFFER_ACCEPTANCE,
} from './offer-acceptance.service';

/**
 * How many times `record` re-reads after losing its compare-and-set.
 *
 * One loss is ordinary: the customer pressed **Lock it in** while the model was composing, or two
 * turns raced. The re-read then finds a settled session and answers from it. Three is a backstop
 * against a pathological interleaving, never a retry budget anybody should reach.
 */
const MAX_RECORD_ATTEMPTS = 3;

export interface NegotiationContextResult {
    sessionId: string;
    round: number;
    currency: string;
    /** ⚠ The vendor's real minimum. Handed to the model deliberately — plan D-2. */
    floor: number;
    /** The asking price, and what the storefront displays. */
    ask: number;
    quantity: number;
    /** The last price this session quoted, or null on the first turn. */
    currentCounter: number | null;
    lastCustomerOffer: number | null;
    offers: Array<{ round: number; customerOffer: number | null; agentProposedPrice: number }>;
    /** The durable behavioural profile. Empty on a customer who has never haggled. */
    traits: Record<string, string | number | boolean>;
    stats: { sessionsStarted: number; sessionsAgreed: number; lastSessionAt: Date | null };
    expiresAt: Date;
    /**
     * ⭐ **The deal on this line is ALREADY CLOSED** — non-null whenever a live, unspent price lock
     * exists for this exact (customer, variant, quantity).
     *
     * ── WHY THE MODEL HAS TO BE TOLD ────────────────────────────────────────
     * `context` used to resume only `open` sessions, so a haggle closed a moment ago was invisible
     * here: the next turn opened a FRESH session at round 0, and the agent — whose chat memory
     * never saw the close, because a button press is not a message it read — would cheerfully
     * start bargaining again over something the customer had already bought at an agreed price.
     * That became reachable the day the customer could close a deal themselves by pressing
     * **Lock it in**.
     *
     * So an agreed session is now RESUMED rather than replaced, and this field says so. The gate
     * refuses a priced turn on it in any case (`session_closed`), which is the guarantee; this is
     * what lets the agent behave correctly instead of merely being stopped.
     *
     * ⚠ **The lock's handle is deliberately NOT here.** It is a bearer credential for a price, and
     * the model has no use for one: the line is already in the basket, spent later by checkout.
     */
    agreed: {
        unitPrice: number;
        expiresAt: Date;
        /** `button` = the customer pressed the offer; `model` = the agent closed it through the gate. */
        closedBy: NegotiationLockCloser;
    } | null;
}

export type NegotiationRecordResult =
    | {
        verdict: 'approved';
        sessionId: string;
        round: number;
        /** The sentence to send, unchanged from what was submitted. */
        reply: string;
        agreedPrice: number;
        lock: { ref: string; unitPrice: number; expiresAt: Date } | null;
      }
    | {
        verdict: 'revise';
        sessionId: string;
        code: string;
        /** An instruction for the MODEL, in English. Never customer copy. */
        instruction: string;
        details: Record<string, unknown>;
      };

/**
 * The negotiation gate and its ledger.
 *
 * Two operations, mirroring the two tools the sub-agent is given:
 *
 *   `context` — open or resume this line's session and hand over everything the
 *               model needs to take a turn, including the real window.
 *   `record`  — judge the price the model wants to quote, persist the turn, and
 *               mint the lock when the model asks for one.
 *
 * ── `record` is a GATE, and it runs BEFORE the customer sees anything ────────
 *
 * Plan D-4. The automation layer submits the sentence it intends to send and only
 * sends it once this returns `approved`. That is what makes "the bot never promises
 * a price the cart cannot honour" true by construction rather than by the model
 * being careful. The `PriceResolverService` guard behind it is a backstop that
 * should never fire.
 *
 * ── A refusal is NOT an HTTP error ───────────────────────────────────────────
 *
 * `judgeProposedPrice` returning a refusal produces a **200** with
 * `verdict: 'revise'`. It is a normal, expected outcome — the model proposed
 * something outside the window and is being told to try again — and turning it into
 * a 4xx would put an exception on the happy path of an agent that is working
 * correctly, and would tempt the automation layer into a retry loop instead of a
 * re-draft. The 4xx codes are reserved for the caller getting the CALL wrong
 * (unknown session, unresolvable identity, a variant that is not bargainable).
 */
export class NegotiationService {

    /** Open or resume the session for (customer, variant, quantity). */
    async context(input: NegotiationContextInput): Promise<NegotiationContextResult> {
        const caller = await botIdentityService.resolve(input.identity);
        const window = await this.readLiveWindow(input.variantId);

        /**
         * ⭐ **A closed deal is resumed, not replaced.** An agreed session holding a live, unspent
         * lock is this line's current state, and handing the model a fresh round-0 session instead
         * is what let the agent reopen a haggle the customer had already settled — see `agreed` on
         * the result. Only a lock that is spent or lapsed falls through to a new negotiation, which
         * is correct: then there really is nothing in force.
         */
        const session =
            (await this.findAgreedSession(caller.customerId, input))
            ?? (await this.openOrResume(caller, input, window));

        /**
         * Recorded only while the haggle is live. Writing the customer's number onto a session
         * whose price is already agreed would edit the record of a closed deal.
         */
        if (input.customerOffer !== undefined && session.status === 'open') {
            session.last_customer_offer = input.customerOffer;
            await session.save();
        }

        const profile = await negotiationProfileRepository.findOrEmpty(caller.customerId);

        return {
            sessionId: session._id.toString(),
            round: session.round,
            currency: session.currency,
            floor: window.floor,
            ask: window.ask,
            quantity: session.quantity,
            currentCounter: session.current_counter ?? null,
            lastCustomerOffer: session.last_customer_offer ?? null,
            offers: session.turns.map((turn) => ({
                round: turn.round,
                customerOffer: turn.customer_offer ?? null,
                agentProposedPrice: turn.agent_proposed_price,
            })),
            traits: profile.traits,
            stats: {
                sessionsStarted: profile.sessions_started,
                sessionsAgreed: profile.sessions_agreed,
                lastSessionAt: profile.last_session_at ?? null,
            },
            expiresAt: session.expires_at,
            agreed:
                session.status === 'agreed' && session.lock
                    ? {
                          unitPrice: session.lock.unit_price,
                          expiresAt: session.lock.expires_at,
                          closedBy: session.lock.closed_by ?? 'model',
                      }
                    : null,
        };
    }

    /**
     * The gate. Judge, persist, and mint a lock when the model asks for one.
     *
     * ── ⛔ THE WRITE IS A COMPARE-AND-SET, AND THE LOOP IS WHY ───────────────
     * A session has two writers now: this, and a customer pressing **Lock it in** on the agent's
     * latest offer. Both decide against a session they have just read, so the write must only land
     * if nothing moved in between — `appendTurnIfStillOpen` refuses otherwise
     * (`repositories/negotiation-session.store.ts` has the interleaving that used to lose a deal).
     *
     * A refused write is not an error: it means the session moved, so this re-reads and judges
     * again against what is actually there. What the loser is told follows from that state and is
     * never silence — a session the button closed answers `session_closed` carrying the agreed
     * price, which `reviseInstruction` turns into "the customer already accepted; do not quote a
     * price", and an expired one answers `session_expired`.
     */
    async record(input: NegotiationRecordInput): Promise<NegotiationRecordResult> {
        const caller = await botIdentityService.resolve(input.identity);

        for (let attempt = 0; attempt < MAX_RECORD_ATTEMPTS; attempt += 1) {
            const session = await NegotiationSessionModel.findOne({
                _id: this.asObjectId(input.sessionId),
                customer_id: new Types.ObjectId(caller.customerId),
                deletedAt: null,
            });

            // Scoped to the caller, so a wrong session id is a 404 rather than a 403 —
            // the same rule `findByIdAndAgent` follows. Telling a caller that a session
            // exists but is somebody else's is itself a disclosure.
            if (!session) throw createAppError(ERROR_CODES.NEGOTIATION_SESSION_NOT_FOUND, 404);

            // Re-read the window EVERY turn (invariant 3). The snapshots on the session
            // are audit only; judging against them would let a vendor's price edit be
            // exploited for the life of the session.
            const window = await this.readLiveWindow(session.variant_id.toString());

            const now = new Date();
            const readAtRound = session.round;
            const verdict = judgeProposedPrice({
                floor: window.floor,
                ask: window.ask,
                proposedPrice: input.agentProposedPrice,
                previousCounter: session.current_counter ?? null,
                sessionStatus: session.status,
                sessionExpiresAt: session.expires_at,
                now,
            });

            if (!verdict.approved) {
                /**
                 * Expiry discovered by reading is written down, so the next turn does not have to
                 * re-derive it and the status column tells the truth.
                 *
                 * ⚠ **Guarded like every other write here.** An unguarded `status: 'expired'`
                 * landing just after a press closed the deal would re-label an agreed session, and
                 * `context` would stop reporting the close — so the agent would reopen a haggle the
                 * customer had already settled.
                 */
                if (verdict.refusal === 'session_expired' && session.status === 'open') {
                    await negotiationSessionStore.markExpiredIfStillOpen(
                        session._id.toString(),
                        caller.customerId,
                        readAtRound,
                    );
                }
                return this.revise(session, verdict.refusal, this.refusalDetails(session, verdict.details));
            }

            // The traits are written even on a turn that mints no lock: what the model
            // learned about the person is true regardless of whether the deal closed, and
            // it is the half that has to survive the session.
            if (input.traits) {
                await negotiationProfileRepository.replaceTraits(caller.customerId, input.traits);
            }

            let lock: { ref: string; unitPrice: number; expiresAt: Date } | null = null;
            const expiresAt = new Date(now.getTime() + NEGOTIATION_CONFIG.LOCK_TTL_MINUTES * 60_000);
            // 128 bits of randomness, hex. The handle is what the cart presents, so it
            // is deliberately NOT the session id: a session id is guessable from a
            // listing and appears in logs, and a lock is a bearer credential for a price.
            const ref = `nlk_${crypto.randomBytes(16).toString('hex')}`;

            const written = await negotiationSessionStore.appendTurnIfStillOpen(
                session._id.toString(),
                caller.customerId,
                readAtRound,
                {
                    turn: {
                        at: now,
                        round: readAtRound + 1,
                        customer_offer: input.customerOffer ?? null,
                        agent_proposed_price: input.agentProposedPrice,
                        lock_requested: input.lock,
                        reply: input.reply,
                    },
                    counter: input.agentProposedPrice,
                    ...(input.customerOffer !== undefined ? { customerOffer: input.customerOffer } : {}),
                    ...(input.lock
                        ? {
                              lock: {
                                  ref,
                                  closed_by: 'model' as const,
                                  unit_price: input.agentProposedPrice,
                                  // Stream C/E's uplift basis, snapshotted HERE at the moment of
                                  // agreement. Re-reading it at split time would read a floor the
                                  // vendor may since have changed, and the 30% would be computed
                                  // against a number nobody agreed to.
                                  floor_snapshot: window.floor,
                                  issued_at: now,
                                  expires_at: expiresAt,
                                  consumed_at: null,
                                  consumed_by_order_id: null,
                              },
                          }
                        : {}),
                },
            );

            /**
             * Somebody else moved the session between the read and the write — the customer's own
             * press, or a concurrent turn. Re-read and judge against what is there now; the answer
             * comes from the fresh state rather than from this stale one.
             */
            if (!written) continue;

            if (input.lock) {
                lock = { ref, unitPrice: input.agentProposedPrice, expiresAt };
                await negotiationProfileRepository.recordAgreement(caller.customerId);
            }

            return {
                verdict: 'approved',
                sessionId: session._id.toString(),
                round: readAtRound + 1,
                reply: input.reply,
                agreedPrice: input.agentProposedPrice,
                lock,
            };
        }

        /**
         * Three reads in a row each lost their write. That is not a state any real conversation
         * produces — it needs a third writer hammering one session — so it is answered as a
         * conflict rather than retried forever, and the model re-reads its context next turn.
         */
        throw createAppError(
            ERROR_CODES.NEGOTIATION_SESSION_CLOSED,
            409,
            'That negotiation is being changed elsewhere',
        );
    }

    /**
     * Accept the agent's standing offer on the customer's behalf — the **Lock it in** press.
     *
     * The decision and its compare-and-set live in `services/offer-acceptance.service.ts`; this is
     * the module's door onto them, so a caller outside `negotiation` never reaches past the
     * service layer. The basket write belongs to the caller: this mints the lock, exactly as the
     * gate does when the model closes a deal, and nothing here touches a cart.
     */
    async acceptOffer(input: AcceptOfferInput): Promise<AcceptOfferOutcome> {
        return acceptOffer(MONGO_OFFER_ACCEPTANCE, input);
    }

    // ── internals ────────────────────────────────────────────────────────────

    private revise(
        session: INegotiationSession,
        refusal: GateRefusal,
        details: Record<string, unknown>,
    ): NegotiationRecordResult {
        return {
            verdict: 'revise',
            sessionId: session._id.toString(),
            code: REFUSAL_CODES[refusal],
            instruction: reviseInstruction(refusal, details),
            details,
        };
    }

    /**
     * The refusal's own details, plus **what was agreed** when the session is already closed.
     *
     * ⚠ **This is what makes a lost race legible to the model.** `judgeProposedPrice` can only
     * report `status: 'agreed'` — it is pure and sees no lock — and "this negotiation is closed" is
     * a dead end for an agent mid-sentence. With the price and the closer attached, the instruction
     * becomes the actionable truth: the customer has accepted this price, by their own press, so
     * stop selling and talk about delivery.
     */
    private refusalDetails(
        session: INegotiationSession,
        details: Record<string, unknown>,
    ): Record<string, unknown> {
        if (session.status !== 'agreed' || !session.lock) return details;
        return {
            ...details,
            agreedPrice: session.lock.unit_price,
            closedBy: session.lock.closed_by ?? 'model',
        };
    }

    /**
     * The closed deal in force on this line, if there is one.
     *
     * A lock that is **spent** (an order exists) or **lapsed** does not count: both mean nothing is
     * in force, and a fresh negotiation is the right answer. Sorted newest-first because a line may
     * have been haggled more than once over its life and only the latest close is current.
     */
    private async findAgreedSession(customerId: string, input: NegotiationContextInput) {
        return NegotiationSessionModel.findOne({
            customer_id: new Types.ObjectId(customerId),
            variant_id: new Types.ObjectId(input.variantId),
            quantity: input.quantity,
            status: 'agreed',
            deletedAt: null,
            'lock.consumed_at': null,
            'lock.expires_at': { $gt: new Date() },
        }).sort({ updatedAt: -1 });
    }

    /**
     * The variant's window as it stands now.
     *
     * Refuses a variant with no effective window — `isBargainEffective` is the same
     * derivation the vendor's own read model reports as `bargainable`, so a variant
     * the dashboard shows as non-negotiable cannot be negotiated through this door.
     *
     * ⚠ **The READ lives in `LiveWindowReader`; only the mapping to codes is here.**
     * `NegotiatedPriceResolver` asks the same reader when it re-validates a lock
     * (D-10), and the two must agree about what the window is down to the
     * `isBargainEffective` gate. What differs is what an absence MEANS: this door
     * is a tool being told it named something unusable, so it raises the
     * catalogue's own codes; the resolver holds a price promise, so it answers
     * `window_moved`. Hence a shared reader returning a miss, and one switch each.
     */
    private async readLiveWindow(variantId: string): Promise<LiveWindow> {
        const read = await liveWindowReader.read(variantId);
        if (read.ok) return read.window;

        switch (read.miss) {
            case 'variant_not_found':
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
            case 'variant_archived':
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);
            case 'product_not_found':
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
            case 'product_inactive':
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, {
                    status: read.productStatus,
                });
            case 'not_bargainable':
                throw createAppError(ERROR_CODES.NEGOTIATION_NOT_BARGAINABLE, 422, undefined, {
                    variantId,
                });
        }
    }

    private async openOrResume(
        caller: { userId: string; customerId: string },
        input: NegotiationContextInput,
        window: LiveWindow,
    ) {
        const now = new Date();

        const existing = await NegotiationSessionModel.findOne({
            customer_id: new Types.ObjectId(caller.customerId),
            variant_id: new Types.ObjectId(input.variantId),
            quantity: input.quantity,
            status: 'open',
            deletedAt: null,
        });

        if (existing) {
            if (existing.expires_at.getTime() > now.getTime()) return existing;
            // Lapsed while nobody was looking. Mark it and fall through to a fresh one
            // rather than resurrecting it — its `current_counter` is a promise made in a
            // conversation the customer has almost certainly forgotten.
            //
            // ⚠ Guarded, like every other write that moves a session out of `open`: a press
            // closing the deal at this exact instant must not be overwritten by an expiry.
            await negotiationSessionStore.markExpiredIfStillOpen(
                existing._id.toString(),
                caller.customerId,
                existing.round,
            );
        }

        const created = await NegotiationSessionModel.create({
            user_id: new Types.ObjectId(caller.userId),
            customer_id: new Types.ObjectId(caller.customerId),
            product_id: new Types.ObjectId(window.productId),
            variant_id: new Types.ObjectId(input.variantId),
            vendor_id: new Types.ObjectId(window.vendorId),
            quantity: input.quantity,
            currency: window.currency,
            status: 'open',
            round: 0,
            turns: [],
            floor_at_open: window.floor,
            ask_at_open: window.ask,
            expires_at: new Date(now.getTime() + NEGOTIATION_CONFIG.SESSION_TTL_MINUTES * 60_000),
        });

        await negotiationProfileRepository.recordSessionStart(caller.customerId);
        return created;
    }

    private asObjectId(id: string): Types.ObjectId {
        if (!Types.ObjectId.isValid(id)) {
            throw createAppError(ERROR_CODES.NEGOTIATION_SESSION_NOT_FOUND, 404);
        }
        return new Types.ObjectId(id);
    }
}

export const negotiationService = new NegotiationService();
