/**
 * ⭐ **WHETHER THE WORDS A CUSTOMER TYPED AFTER CANCELLING MAY BE RECORDED — the whole rule, pure.**
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * "Yes, cancel" cancels the order and the bot then says *"what went wrong? Tell me in your own words
 * and I will pass it on"* — and until now **nothing recorded the answer.** `OrderService.cancelOrder`
 * writes its own reason to the order timeline, and from a tap that reason is the fixed literal
 * "Cancelled by customer", so the customer's sentence went nowhere. The owner's decision is that a
 * cancellation reason is TYPED, never picked, so the typed words have to reach the order.
 *
 * ── WHERE THE WORDS GO, AND WHY THERE ──────────────────────────────────────
 * Onto the **order timeline**, as `note.added` attributed to the customer. That is the same history
 * `cancelOrder` already writes the cancellation to, so a vendor reads the cancellation and the reason
 * in one place, in order. Nothing is added to the order document, so there is no schema change and no
 * migration — and `note.added` with a `customer` actor is already in the timeline's enum.
 *
 * ── ⚠ CANCELLING IS INDEPENDENT OF ANSWERING, AND MUST STAY SO ──────────────
 * The tap cancels immediately and this route is a separate, later write. A customer who never answers
 * the question has still cancelled their order. Any design where the cancellation waits for the
 * sentence trades a working cancellation for a nicer record, and the customer discovers it by finding
 * their order still live.
 *
 * ── THE FOUR RULES, AND WHY EACH ONE REFUSES ────────────────────────────────
 *   1. **The order must actually be cancelled.** Otherwise the note is a claim about something that
 *      did not happen, sitting in the history a vendor reads.
 *   2. **One reason per cancellation.** The second typed message is REFUSED rather than appended —
 *      the model may retry, a tap may be replayed, and a thread of contradictory sentences in an
 *      order's history is worse than one. A customer with more to say opens a support request, which
 *      is a place built for a conversation.
 *   3. **Bounded in time** (`CANCELLATION_REASON_WINDOW_HOURS`). A button and a chat thread live
 *      indefinitely, so without this an old conversation could attach a sentence to an order months
 *      later, where it reads as a fresh complaint.
 *   4. **Only the order's own customer**, which is not decided here: every read on this surface is
 *      ownership-scoped through `resolveOwnedOrder`, so a stranger's order is a 404 before this rule
 *      is ever consulted. Stated because the pin belongs with the other three.
 *
 * Pure so the three refusals can be asserted without a database — each of them needs a cancelled
 * order, a timeline and a clock, which is exactly the combination nobody reproduces by hand.
 */

/** How long after a cancellation the typed words are still about that cancellation. */
export const CANCELLATION_REASON_WINDOW_HOURS = 24;

/**
 * The metadata flag that makes the note self-describing.
 *
 * ⚠ **Without it the note is indistinguishable from any other customer note**, and the next reader —
 * a vendor screen, an admin, a later feature — would have to infer from position that a sentence is a
 * cancellation reason. It is also what rule 2 counts, so it must be written on every such note.
 */
export const CANCELLATION_REASON_METADATA_KEY = 'cancellationReason';

/** The one event shape this rule reads. Declared locally: it names only what it needs. */
export interface CancellationTimelineFact {
    eventType: string;
    metadata?: Record<string, unknown> | null;
    actorType?: string | null;
    createdAt: Date | string;
}

export type CancellationReasonRefusal = 'not_cancelled' | 'already_recorded' | 'window_closed';

export type CancellationReasonVerdict =
    | { ok: true; cancelledAt: Date }
    | { ok: false; refusal: CancellationReasonRefusal };

const asDate = (value: Date | string): Date | null => {
    const at = value instanceof Date ? value : new Date(value);
    return Number.isFinite(at.getTime()) ? at : null;
};

const isCancellationEvent = (event: CancellationTimelineFact): boolean =>
    event.eventType === 'fulfillment.updated' && event.metadata?.newStatus === 'cancelled';

const isReasonNote = (event: CancellationTimelineFact): boolean =>
    event.eventType === 'note.added' && event.metadata?.[CANCELLATION_REASON_METADATA_KEY] === true;

/**
 * May this order take the customer's typed reason?
 *
 * @param fulfillmentStatus the order's status, as the ownership-scoped read returned it
 * @param events that order's timeline, in any order
 * @param fallbackAt the order's own last-modified instant, used only when the timeline carries no
 *   cancellation event at all. `cancelOrder` awaits that write, so a cancelled order has one — but
 *   refusing a genuinely cancelled order because its history is thin would deny a customer the one
 *   thing this route exists to record, so the clock falls back rather than the rule.
 */
export function judgeCancellationReason(input: {
    fulfillmentStatus: string;
    events: readonly CancellationTimelineFact[];
    fallbackAt: Date | string;
    now?: Date;
}): CancellationReasonVerdict {
    if (input.fulfillmentStatus !== 'cancelled') return { ok: false, refusal: 'not_cancelled' };

    const cancelledAt = input.events
        .filter(isCancellationEvent)
        .map((event) => asDate(event.createdAt))
        .filter((at): at is Date => at !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0]
        ?? asDate(input.fallbackAt);

    if (!cancelledAt) return { ok: false, refusal: 'not_cancelled' };

    /**
     * ⚠ **Counted over the WHOLE timeline, not only after `cancelledAt`.** An order can be cancelled
     * once — `cancelOrder` returns early on an already-cancelled order — so there is no second
     * cancellation for a second reason to belong to, and comparing timestamps would let a note
     * written in the same second as the cancellation slip past on a clock tie.
     */
    if (input.events.some(isReasonNote)) return { ok: false, refusal: 'already_recorded' };

    const now = input.now ?? new Date();
    const elapsedHours = (now.getTime() - cancelledAt.getTime()) / (60 * 60 * 1000);
    if (elapsedHours > CANCELLATION_REASON_WINDOW_HOURS) return { ok: false, refusal: 'window_closed' };

    return { ok: true, cancelledAt };
}
