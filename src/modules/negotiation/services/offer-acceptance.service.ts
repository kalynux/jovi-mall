import crypto from 'crypto';
import { Types } from 'mongoose';

import { NEGOTIATION_CONFIG } from '../config/negotiation.config';
import {
    decideOfferAcceptance,
    OfferSessionView,
    OfferWindowRead,
} from '../domain/offer-acceptance.rule';
import { INegotiationLock, NegotiationSessionModel } from '../models/negotiation-session.model';
import { negotiationProfileRepository } from '../repositories/negotiation-profile.repository';
import { negotiationSessionStore } from '../repositories/negotiation-session.store';
import { liveWindowReader } from './live-window.reader';

/**
 * **Lock it in** — the customer accepting the bargaining agent's latest offer by pressing it.
 *
 * ── WHAT A PRESS DOES ────────────────────────────────────────────────────────
 * Owner's words (2026-09-16): *"behave like add to cart but with the new price being locked."*
 * So a press closes the deal HERE — it mints the same price lock the gate mints when the agent
 * closes one — and the caller then puts the line in the basket with that lock. This file does the
 * first half only; the basket belongs to the caller, exactly as the agent's own lock is spent later
 * by `cart_add_item` rather than by the gate.
 *
 * ── ⛔ ONE LOCK, ONE SPEND ────────────────────────────────────────────────────
 * A chat button does not visibly disable itself, so a double tap is ordinary, not an attack. The
 * lock is written by a compare-and-set on "still open at this round"
 * (`NegotiationSessionStore.lockIfStillOpen`); of two presses exactly one writes, and the other
 * re-reads, finds that lock, and returns IT (`fresh: false`). The caller adds the line with the
 * lock, and a cart add that presents a lock SETS the quantity rather than incrementing it — so two
 * presses produce one line at one price, not two.
 *
 * The same compare-and-set is what `NegotiationService.record` now writes through, so a press
 * racing the agent's own turn has exactly one winner too (see the store's header).
 *
 * ── A refusal is an OUTCOME, never a throw ───────────────────────────────────
 * Every way a press can fail to lock — the offer changed, it ran out, the price moved, it was
 * already ordered — is an ordinary event in a chat, where a button outlives what it was drawn for.
 * Each comes back as a kind the caller turns into a sentence and the right next button. Only a
 * fault throws.
 *
 * ── Dependencies are injected ────────────────────────────────────────────────
 * So `test:inapp-discovery` can run both orders of every race against an in-memory store, and run
 * them again against a store with the guard removed to prove the assertions notice. Production
 * passes `MONGO_OFFER_ACCEPTANCE`.
 */

/** A session as the press needs it: the decision's view, plus what the caller renders with. */
export interface LoadedOfferSession {
    view: OfferSessionView;
    productId: string;
    variantId: string;
    currency: string;
    /** The existing lock's handle, when there is one. */
    lockRef: string | null;
}

export interface OfferAcceptanceDeps {
    /** This customer's session, or null — never somebody else's. */
    load(sessionId: string, customerId: string): Promise<LoadedOfferSession | null>;
    readWindow(variantId: string): Promise<OfferWindowRead>;
    /** The compare-and-set. True only for the call that closed the deal. */
    lockIfStillOpen(sessionId: string, customerId: string, round: number, lock: INegotiationLock): Promise<boolean>;
    markExpiredIfStillOpen(sessionId: string, customerId: string, round: number): Promise<void>;
    recordAgreement(customerId: string): Promise<void>;
    now(): Date;
    newLockRef(): string;
}

/** Everything the caller needs to put the line in the basket, or to say why not. */
export type AcceptOfferOutcome =
    | {
          kind: 'locked';
          /** True for the press that closed the deal; false for one that found it already closed. */
          fresh: boolean;
          sessionId: string;
          productId: string;
          variantId: string;
          quantity: number;
          currency: string;
          unitPrice: number;
          lockRef: string;
          expiresAt: Date;
      }
    | {
          kind: 'superseded';
          sessionId: string;
          productId: string;
          variantId: string;
          currency: string;
          latestRound: number;
          latestPrice: number;
      }
    | { kind: 'already_ordered' | 'expired' | 'price_changed'; productId: string; variantId: string }
    /** Ids are null when no session of this customer's could be found at all. */
    | { kind: 'unavailable'; productId: string | null; variantId: string | null };

export interface AcceptOfferInput {
    /** The `Customer` profile — what sessions, carts and orders scope on. */
    customerId: string;
    sessionId: string;
    round: number;
}

/**
 * How many times a press re-reads after losing a compare-and-set. One loss is a double tap or the
 * agent's turn landing first; the re-read then finds a settled state and returns. Three is a
 * backstop against a pathological interleaving, never a retry budget anybody should reach.
 */
const MAX_ATTEMPTS = 3;

export async function acceptOffer(
    deps: OfferAcceptanceDeps,
    input: AcceptOfferInput,
): Promise<AcceptOfferOutcome> {
    const { customerId, sessionId, round } = input;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const loaded = await deps.load(sessionId, customerId);
        if (!loaded) return { kind: 'unavailable', productId: null, variantId: null };

        const ids = { productId: loaded.productId, variantId: loaded.variantId };
        const now = deps.now();
        const decision = decideOfferAcceptance({
            session: loaded.view,
            pressedRound: round,
            window: await deps.readWindow(loaded.variantId),
            now,
        });

        switch (decision.kind) {
            case 'lock_now': {
                const window = await deps.readWindow(loaded.variantId);
                const lock: INegotiationLock = {
                    ref: deps.newLockRef(),
                    closed_by: 'button',
                    unit_price: decision.unitPrice,
                    // Stream C/E's uplift basis at the moment of agreement, exactly as the gate
                    // snapshots it. The decision has just approved this price against a live window,
                    // so `ok` is the only branch reachable here; the fallback keeps the type honest.
                    floor_snapshot: window.ok ? window.floor : decision.unitPrice,
                    issued_at: now,
                    expires_at: new Date(now.getTime() + NEGOTIATION_CONFIG.LOCK_TTL_MINUTES * 60_000),
                    consumed_at: null,
                    consumed_by_order_id: null,
                };

                const won = await deps.lockIfStillOpen(sessionId, customerId, round, lock);
                if (!won) continue; // Somebody else moved it first. Re-read and answer from that.

                /**
                 * ⚠ **A failed statistic never costs the customer their deal.** The lock is written
                 * and the basket is next; `sessions_agreed` is a profile counter the agent reads for
                 * colour. Throwing here would tell a customer their press failed when it succeeded.
                 */
                await deps.recordAgreement(customerId).catch((error: unknown) => {
                    console.warn('[OfferAcceptance] agreement statistic not recorded', error);
                });

                return {
                    kind: 'locked',
                    fresh: true,
                    sessionId,
                    ...ids,
                    quantity: loaded.view.quantity,
                    currency: loaded.currency,
                    unitPrice: lock.unit_price,
                    lockRef: lock.ref,
                    expiresAt: lock.expires_at,
                };
            }

            case 'reuse_lock':
                // The decision returns this only when the view holds a lock; the ref travels with it.
                if (!loaded.view.lock || !loaded.lockRef) return { kind: 'unavailable', ...ids };
                return {
                    kind: 'locked',
                    fresh: false,
                    sessionId,
                    ...ids,
                    quantity: loaded.view.quantity,
                    currency: loaded.currency,
                    unitPrice: loaded.view.lock.unitPrice,
                    lockRef: loaded.lockRef,
                    expiresAt: loaded.view.lock.expiresAt,
                };

            case 'superseded':
                return {
                    kind: 'superseded',
                    sessionId,
                    ...ids,
                    currency: loaded.currency,
                    latestRound: decision.latestRound,
                    latestPrice: decision.latestPrice,
                };

            case 'expired':
                if (decision.markExpired) {
                    await deps.markExpiredIfStillOpen(sessionId, customerId, loaded.view.round);
                }
                return { kind: 'expired', ...ids };

            case 'already_ordered':
            case 'price_changed':
                return { kind: decision.kind, ...ids };

            case 'unavailable':
                return { kind: 'unavailable', ...ids };
        }
    }

    return { kind: 'unavailable', productId: null, variantId: null };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Production wiring
// ─────────────────────────────────────────────────────────────────────────────

export const MONGO_OFFER_ACCEPTANCE: OfferAcceptanceDeps = {
    async load(sessionId, customerId) {
        // A malformed id is the same answer as an unknown one — confirming the shape is a disclosure.
        if (!Types.ObjectId.isValid(sessionId) || !Types.ObjectId.isValid(customerId)) return null;

        const doc = await NegotiationSessionModel.findOne({
            _id: new Types.ObjectId(sessionId),
            customer_id: new Types.ObjectId(customerId),
            deletedAt: null,
        }).lean();
        if (!doc) return null;

        return {
            view: {
                status: doc.status,
                round: doc.round,
                currentCounter: doc.current_counter ?? null,
                offers: (doc.turns ?? []).map((turn) => ({
                    round: turn.round,
                    agentProposedPrice: turn.agent_proposed_price,
                })),
                expiresAt: doc.expires_at,
                customerId: doc.customer_id.toString(),
                variantId: doc.variant_id.toString(),
                quantity: doc.quantity,
                lock: doc.lock
                    ? {
                          unitPrice: doc.lock.unit_price,
                          expiresAt: doc.lock.expires_at,
                          consumedAt: doc.lock.consumed_at ?? null,
                      }
                    : null,
            },
            productId: doc.product_id.toString(),
            variantId: doc.variant_id.toString(),
            currency: doc.currency,
            lockRef: doc.lock?.ref ?? null,
        };
    },

    /**
     * Through the ONE window reader the gate and the checkout resolver share, so a press judges
     * the same window both of them would. A product taken off sale is `gone`; a cleared bargaining
     * window is not — the price moved, and the customer can be told so and asked again.
     */
    async readWindow(variantId) {
        const read = await liveWindowReader.read(variantId);
        if (read.ok) return { ok: true, floor: read.window.floor, ask: read.window.ask };
        return { ok: false, gone: read.miss !== 'not_bargainable' };
    },

    lockIfStillOpen: (sessionId, customerId, round, lock) =>
        negotiationSessionStore.lockIfStillOpen(sessionId, customerId, round, lock),

    markExpiredIfStillOpen: (sessionId, customerId, round) =>
        negotiationSessionStore.markExpiredIfStillOpen(sessionId, customerId, round),

    recordAgreement: (customerId) => negotiationProfileRepository.recordAgreement(customerId),

    now: () => new Date(),

    // The gate's handle shape exactly: 128 random bits, never the session id — a lock is a bearer
    // credential for a price, and a session id appears in chat buttons and logs.
    newLockRef: () => `nlk_${crypto.randomBytes(16).toString('hex')}`,
};
