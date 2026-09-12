import {
    LockVerdict,
    NegotiatedPriceContext,
} from '../../catalog/domain/ports/negotiated-price.port';

/**
 * Whether a presented price lock may be honoured — the whole of the decision,
 * as a pure function.
 *
 * ── Why this is separate from the resolver ──────────────────────────────────
 *
 * `NegotiatedPriceResolver` does the I/O: find the session by its lock handle,
 * re-read the vendor's window, burn the lock inside the caller's transaction.
 * The JUDGEMENT is here, for the same reason `negotiation-gate.rule.ts` sits
 * next to `NegotiationService` — a rule deciding what a customer is charged
 * should be exhaustively testable at a boundary, and neither Mongo nor a clock
 * belongs in it. `test:negotiation-lock` reaches every branch below with no
 * database.
 *
 * ── The verdict is OURS; the error mapping is catalog's (plan D-11) ─────────
 *
 * This returns a `LockVerdict` and never throws. `PriceResolverService` maps the
 * five refusal reasons onto the `NEGOTIATION_LOCK_*` codes and does no price
 * judgement of its own. Throwing from here would bypass that mapping and hand
 * the chat a 500 it cannot explain to a customer.
 *
 * ⚠ **The reason set is CLOSED.** A sixth value costs a change on both sides —
 * catalog's `LOCK_REFUSAL_CODES`, its status table, and the bot copy explaining
 * each one — so an unanticipated situation refuses with the closest existing
 * reason rather than inventing a value that renders as `NEGOTIATION_LOCK_INVALID`
 * anyway.
 */

/** The lock as stored on the session. Only the fields the judgement reads. */
export interface StoredLock {
    /** Per unit, agreed with the customer. What they will be charged. */
    unit_price: number;
    expires_at: Date;
    /** Non-null = already spent by an order. */
    consumed_at?: Date | null;
}

/**
 * What the lock is bound to, read off the SESSION rather than off the lock.
 *
 * The binding is the session's `(customer_id, variant_id, quantity)` — the
 * playbook's iron rule 1, that a different quantity or variant is "a new deal",
 * enforced by it being a different session. The lock therefore inherits its
 * binding from the session that minted it and holds no copy of its own to drift.
 */
export interface LockBinding {
    customerId: string;
    variantId: string;
    quantity: number;
}

/** The vendor's window as it stands at the moment of THIS verdict. */
export interface LockWindow {
    /** `variant.price` — the vendor's real minimum, never the displayed ask. */
    floor: number;
    /** `bargain.maxPrice` — the ceiling, and what the storefront displays. */
    ask: number;
}

export interface LockJudgement {
    lock: StoredLock;
    binding: LockBinding;
    /** What the cart or the order is presenting the lock FOR. */
    presented: NegotiatedPriceContext;
    /**
     * `null` when the variant has no EFFECTIVE window any more — the vendor
     * cleared it, or the product left the AI index. Judged `window_moved`; the
     * branch below says why that is the customer-favourable answer.
     */
    window: LockWindow | null;
    now: Date;
}

export function judgeLock(input: LockJudgement): LockVerdict {
    const { lock, binding, presented, window, now } = input;

    /**
     * 1 · The wrong customer is `not_found`, NOT a refusal of its own.
     *
     * The house rule, stated at `NegotiationService.record`'s own session lookup:
     * "telling a caller that a session exists but is somebody else's is itself a
     * disclosure". A lock handle is a bearer credential for a price, so
     * confirming that a guessed one is real — merely someone else's — is the one
     * answer worth withholding. There is no reason value for it, and there
     * should not be.
     */
    if (binding.customerId !== presented.customerId) return { ok: false, reason: 'not_found' };

    /**
     * 2 · The binding, before any state.
     *
     * A lock presented for a different line is answered as such whether or not it
     * has since lapsed: "this is not for that item" is the actionable truth, and
     * reporting `expired` would send the bot off to re-negotiate the wrong thing.
     *
     * ⚠ A quantity mismatch also lands on `mismatch`, which catalog renders as
     * `NEGOTIATION_LOCK_VARIANT_MISMATCH`. The name is narrower than the rule —
     * the closed set has no `quantity_mismatch`, and adding one is the two-sided
     * change the port's header describes. In practice the cart clears the ref on
     * a quantity change (`dropNegotiatedPrice`), so this is a backstop against a
     * ref presented directly.
     */
    if (binding.variantId !== presented.variantId) return { ok: false, reason: 'mismatch' };
    if (binding.quantity !== presented.quantity) return { ok: false, reason: 'mismatch' };

    /**
     * 3 · Spent before lapsed.
     *
     * A lock can be both. `consumed` is the more useful of the two facts — it
     * means an order exists and the customer is probably looking at a stale chat
     * message — whereas `expired` invites a re-negotiation that would duplicate a
     * purchase they have already made.
     */
    if (lock.consumed_at != null) return { ok: false, reason: 'consumed' };

    /**
     * 4 · Expiry is judged on the LOCK, never on its session.
     *
     * The two TTLs differ and mean different things: `SESSION_TTL_MINUTES` (30)
     * is how long a haggle stays resumable, `LOCK_TTL_MINUTES` (20) is how long
     * the agreed price stays spendable. The lock is the credential, so its clock
     * is the one that binds — a session marked `expired` around a lock still
     * inside its own TTL must still be honoured.
     *
     * `>=` rather than `>`: the boundary instant is outside the window.
     */
    if (now.getTime() >= lock.expires_at.getTime()) return { ok: false, reason: 'expired' };

    /**
     * 5 · D-10 — the window as it stands NOW, and the only place it is re-derived.
     *
     * The owner's decision, and it deliberately accepts a failure the gate exists
     * to prevent: a customer quoted 38 000 can be refused because the vendor
     * raised their floor to 40 000 in the meantime, having done nothing wrong.
     * What it buys is that a vendor is NEVER paid below the floor in force at the
     * moment of sale. The two obligations that decision carries — a short lock
     * TTL, and a refusal the chat can explain and act on — are
     * `NEGOTIATION_CONFIG.LOCK_TTL_MINUTES` and this being `window_moved` rather
     * than a generic error.
     *
     * ⚠ A cleared window (`null`) refuses too, and that is customer-favourable
     * rather than pedantic. Under D-1 a bargainable variant is shelved at its
     * ASK, so removing the window drops the displayed price to `variant.price` —
     * the floor. Honouring a 38 000 lock against a shelf now reading 30 000 would
     * charge the customer more than the storefront advertises, which is precisely
     * the direction this whole seam refuses to fail in.
     */
    if (window === null) return { ok: false, reason: 'window_moved' };
    if (lock.unit_price < window.floor) return { ok: false, reason: 'window_moved' };
    if (lock.unit_price > window.ask) return { ok: false, reason: 'window_moved' };

    /**
     * `floorSnapshot` is the LIVE floor, not `lock.floor_snapshot`.
     *
     * ⚠ This is the subtle one, and the two instructions that look contradictory
     * agree once you read which MOMENT each is about. The port: "the vendor's
     * floor as of THIS verdict, and it is the number the earnings split must
     * use". The published lock shape: "do not re-read `variant.price` at SPLIT
     * time". Both hold — the floor is read here, at the verdict, written onto the
     * order item as `floor_price_snapshot`, and the split reads that column and
     * never the variant again.
     *
     * Returning `lock.floor_snapshot` (the agreement-time basis) would
     * under-report the floor whenever a vendor raised it mid-lock, and the AI
     * margin would then take 30% of an uplift measured against a floor no longer
     * in force. Check 5 has already established `unit_price >= window.floor`, so
     * the invariant the split relies on — `vendorGross >= floor x qty` — holds by
     * construction.
     *
     * `lock.floor_snapshot` stays on the session as the audit record of what the
     * window was when the deal was struck. It is deliberately not read here.
     */
    return { ok: true, unitPrice: lock.unit_price, floorSnapshot: window.floor };
}
