/**
 * How much an UNVERIFIED owner may still take out — the rolling-window allowance.
 *
 * ── Why a window, and not a per-request ceiling ──────────────────────────────
 *
 * The first version of this capped one request. That bounds a single approval and nothing
 * more: only one payout may be *pending* per owner (a partial unique index enforces it), but
 * the moment an administrator marks it paid the owner may open another. At a 20,000 cap an
 * unverified owner holding 200,000 requests ten times and takes all of it, having proved
 * nothing. The cap has to be an allowance over a period or it is only a speed bump.
 *
 * ── Why ROLLING and not calendar ─────────────────────────────────────────────
 *
 * A calendar month resets on the 1st, so an owner who has exhausted the allowance on the 31st
 * takes the same amount again the next day — twice the cap inside 48 hours, which is exactly
 * the burst this exists to prevent. A trailing window bounds *any* N-day stretch, and there is
 * no boundary to sit and wait for.
 *
 * ── What counts ──────────────────────────────────────────────────────────────
 *
 * Only `paid` requests, windowed on `resolved_at`.
 *
 *   - A **rejected** request returned the money to `available_balance`. Counting it would
 *     charge the owner for an administrator's decision and could strand them at zero
 *     allowance having received nothing.
 *   - A **pending** request cannot be double-counted, because a new one cannot be opened while
 *     one is pending.
 *   - `resolved_at`, not `created_at`, because the question is when money actually left. A
 *     request opened 31 days ago and paid yesterday is recent spending, and a `created_at`
 *     window would let it fall out while the cash was still warm.
 *
 * Pure and dependency-free so the arithmetic can be tested for what it is: a money rule where
 * every boundary case is a way to hand out more than intended.
 */

export interface PayoutAllowance {
    /** False when the feature is off or the owner is verified — no ceiling applies. */
    capped: boolean;
    /** The full allowance per window. `0` when uncapped. */
    cap: number;
    /** Already taken out inside the window. */
    used: number;
    /** What is left. Never negative — see below. */
    remaining: number;
    windowDays: number;
    /**
     * When some allowance next frees up: the oldest counted payout's `resolved_at` plus the
     * window. `null` when nothing is counted (so nothing is waiting to expire) or when
     * uncapped.
     *
     * ⚠ It is when the FIRST tranche frees, not when the full cap returns. A client must not
     * promise the owner their whole allowance back on that date.
     */
    resetsAt: Date | null;
}

export const UNCAPPED: PayoutAllowance = Object.freeze({
    capped: false,
    cap: 0,
    used: 0,
    remaining: 0,
    windowDays: 0,
    resetsAt: null,
});

export function computeAllowance(input: {
    cap: number;
    windowDays: number;
    /** Sum of `paid` payouts resolved inside the window. */
    used: number;
    /** `resolved_at` of the OLDEST payout counted, or null when none were. */
    oldestResolvedAt: Date | null;
}): PayoutAllowance {
    /**
     * ⚠ A cap of `0` — the shipped default — means the feature is off, NOT an allowance of
     * nothing. Reading it the other way would freeze every unverified payout on the platform
     * the moment this code deployed. A negative from a mistyped env reads the same way.
     */
    if (input.cap <= 0) return UNCAPPED;

    /**
     * ⚠ `Math.max(0, …)` is not defensive padding. `used` can legitimately EXCEED the cap:
     * the cap can be lowered while payouts made under the old one are still inside the
     * window. Without the clamp `remaining` goes negative, and a negative ceiling handed to
     * the balance move would read as "no cap" — lowering the cap would remove it.
     */
    const remaining = Math.max(0, input.cap - Math.max(0, input.used));

    return {
        capped: true,
        cap: input.cap,
        used: Math.max(0, input.used),
        remaining,
        windowDays: input.windowDays,
        resetsAt: input.oldestResolvedAt
            ? new Date(input.oldestResolvedAt.getTime() + input.windowDays * 86_400_000)
            : null,
    };
}

/** The start of the trailing window. */
export function windowStart(windowDays: number, now: Date = new Date()): Date {
    return new Date(now.getTime() - windowDays * 86_400_000);
}
