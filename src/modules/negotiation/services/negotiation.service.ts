import crypto from 'crypto';
import { Types } from 'mongoose';

import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { isBargainEffective } from '../../catalog/domain/services/bargain-price.rule';
import { botIdentityService } from '../../bot-surface/services/bot-identity.service';
import { NEGOTIATION_CONFIG } from '../config/negotiation.config';
import {
    GateRefusal,
    REFUSAL_CODES,
    judgeProposedPrice,
    reviseInstruction,
} from '../domain/negotiation-gate.rule';
import { INegotiationSession, NegotiationSessionModel } from '../models/negotiation-session.model';
import { negotiationProfileRepository } from '../repositories/negotiation-profile.repository';
import { NegotiationContextInput, NegotiationRecordInput } from '../validators/negotiation.validator';

/** The live window, read fresh on every turn. Never a snapshot — see invariant 3. */
interface LiveWindow {
    floor: number;
    ask: number;
    productId: string;
    vendorId: string;
    currency: string;
}

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
    constructor(
        private readonly products = new ProductRepositoryMongo(),
        private readonly variants = new VariantRepositoryMongo(),
    ) {}

    /** Open or resume the session for (customer, variant, quantity). */
    async context(input: NegotiationContextInput): Promise<NegotiationContextResult> {
        const caller = await botIdentityService.resolve(input.identity);
        const window = await this.readLiveWindow(input.variantId);

        const session = await this.openOrResume(caller, input, window);

        if (input.customerOffer !== undefined) {
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
        };
    }

    /** The gate. Judge, persist, and mint a lock when the model asks for one. */
    async record(input: NegotiationRecordInput): Promise<NegotiationRecordResult> {
        const caller = await botIdentityService.resolve(input.identity);

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
            // Expiry discovered by reading is written down, so the next turn does not
            // have to re-derive it and the status column tells the truth.
            if (verdict.refusal === 'session_expired' && session.status === 'open') {
                session.status = 'expired';
                await session.save();
            }
            return this.revise(session, verdict.refusal, verdict.details);
        }

        // The traits are written even on a turn that mints no lock: what the model
        // learned about the person is true regardless of whether the deal closed, and
        // it is the half that has to survive the session.
        if (input.traits) {
            await negotiationProfileRepository.replaceTraits(caller.customerId, input.traits);
        }

        session.round += 1;
        session.current_counter = input.agentProposedPrice;
        if (input.customerOffer !== undefined) session.last_customer_offer = input.customerOffer;
        session.turns.push({
            at: now,
            round: session.round,
            customer_offer: input.customerOffer ?? null,
            agent_proposed_price: input.agentProposedPrice,
            lock_requested: input.lock,
            reply: input.reply,
        });

        let lock: { ref: string; unitPrice: number; expiresAt: Date } | null = null;

        if (input.lock) {
            const expiresAt = new Date(
                now.getTime() + NEGOTIATION_CONFIG.LOCK_TTL_MINUTES * 60_000,
            );
            // 128 bits of randomness, hex. The handle is what the cart presents, so it
            // is deliberately NOT the session id: a session id is guessable from a
            // listing and appears in logs, and a lock is a bearer credential for a price.
            const ref = `nlk_${crypto.randomBytes(16).toString('hex')}`;

            session.lock = {
                ref,
                unit_price: input.agentProposedPrice,
                // Stream C/E's uplift basis, snapshotted HERE at the moment of agreement.
                // Re-reading it at split time would read a floor the vendor may since
                // have changed, and the 30% would be computed against a number nobody
                // agreed to.
                floor_snapshot: window.floor,
                issued_at: now,
                expires_at: expiresAt,
                consumed_at: null,
                consumed_by_order_id: null,
            };
            session.status = 'agreed';
            lock = { ref, unitPrice: input.agentProposedPrice, expiresAt };
        }

        await session.save();

        if (input.lock) {
            await negotiationProfileRepository.recordAgreement(caller.customerId);
        }

        return {
            verdict: 'approved',
            sessionId: session._id.toString(),
            round: session.round,
            reply: input.reply,
            agreedPrice: input.agentProposedPrice,
            lock,
        };
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
     * The variant's window as it stands now.
     *
     * Refuses a variant with no effective window — `isBargainEffective` is the same
     * derivation the vendor's own read model reports as `bargainable`, so a variant
     * the dashboard shows as non-negotiable cannot be negotiated through this door.
     */
    private async readLiveWindow(variantId: string): Promise<LiveWindow> {
        const variant = await this.variants.findById(variantId);
        if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
        if (variant.status !== 'active') {
            throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);
        }

        const product = await this.products.findByIdUnscoped(variant.productId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.status !== 'active') {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, {
                status: product.status,
            });
        }

        if (!isBargainEffective(product.vectorisationEnabled, variant.bargain)) {
            throw createAppError(ERROR_CODES.NEGOTIATION_NOT_BARGAINABLE, 422, undefined, {
                variantId,
            });
        }

        // Non-null by `isBargainEffective`, which is the point of routing through it
        // rather than testing `variant.bargain` here and having two opinions.
        const bargain = variant.bargain!;

        return {
            // ⚠ `variant.price`, never `bargain.minPrice`. The two are kept identical by
            // `resolveBargainWrite`, and reading the price is what keeps this correct if
            // that invariant is ever relaxed.
            floor: variant.price,
            ask: bargain.maxPrice,
            productId: variant.productId,
            vendorId: product.vendorId,
            currency: NEGOTIATION_CONFIG.DEFAULT_CURRENCY,
        };
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
            existing.status = 'expired';
            await existing.save();
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
