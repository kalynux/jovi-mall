/**
 * What a closing screen says HAPPENED, stamped into its completion.
 *
 * ── ⛔ THE GAP THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * A WhatsApp customer who presses "Add to cart" or "Bargain" in the product form sees the
 * outcome on the closing screen — and then the form closes and the thread is EMPTY. There is no
 * WhatsApp push (`pushIntoConversation` is Telegram-only, by construction: a Mini App cannot
 * write to a chat, a Flow completion can), and `flow_complete` was silent for every finished
 * product form. So on Telegram the customer is left holding three buttons and a question in the
 * conversation, and on WhatsApp they are left holding nothing.
 *
 * That matters most for the two rungs that WRITE NOTHING: a bargain or a booking is a
 * conversation, and the agent wakes on the customer's next message. A question the customer can
 * no longer see is a question nobody answers.
 *
 * ── ⚠ THE STAMP ROUTES. IT NEVER CARRIES CONTENT ────────────────────────────
 * The completion travels out through Meta and back in through the automation layer, so its
 * payload is **caller-supplied** by the time it reaches us. A stamp may therefore decide WHICH
 * of a closed set of answers to give; it may never be echoed to a customer, and nothing is read
 * from it that the session already knows. Everything the reply says is rebuilt here from the
 * session and the live catalogue — which also means the rung is re-resolved rather than trusted,
 * the rule the whole purchase surface is built on.
 *
 * ⚠ **A value outside this set means a Flow published later than this code.** It is treated as
 * `notice`: say nothing rather than guess at what happened.
 */
export const FLOW_OUTCOMES = Object.freeze([
    'notice',
    'added',
    'asked',
    'placed',
    'booked',
    'moved',
] as const);

export type FlowOutcome = (typeof FLOW_OUTCOMES)[number];

/**
 * What each value means, and what the chat owes the customer for it:
 *
 *   `notice`  nothing happened — an empty shelf, a lapsed handle, a refusal. The screen said it;
 *             the chat adds nothing.
 *   `added`   the basket changed. The chat repeats it and offers the same three controls a
 *             chat-tap "added to cart" offers, because the screen's are gone once it closes.
 *   `asked`   the customer was asked a question (bargain, booking) that they answer by typing.
 *             The chat must carry that question, or it is asked into a closed screen.
 *   `placed`  the checkout was placed. The chat stays quiet on purpose: the payment RESULT
 *             arrives through the payment path, and a "got that" here would talk over it.
 *   `booked`  an appointment was made. The chat acknowledges it — CONTENT-FREE, plus a "My
 *             bookings" button — because the platform's own booking notification picks one
 *             secondary channel (telegram > email > whatsapp) and is mutable by a preference, so
 *             a WhatsApp customer with a verified email could otherwise hear nothing at all in
 *             the conversation they just booked from.
 *   `moved`   the same, for a RESCHEDULE. ⚠ Its own value rather than a flag on `booked`,
 *             because telling somebody their appointment is "booked" when they moved one reads
 *             as a second appointment.
 *
 * ⚠ **`booked` and `moved` carry NOTHING about the appointment**, and that is the point: the
 * screen showed the reference and the time while the session was live and provable, and by the
 * time the chat speaks the handle is spent and the completion is caller-supplied. The button is
 * how the customer reaches those details again — a tap code is not content, it opens a screen
 * that resolves the sender's own session server-side.
 */
export const asFlowOutcome = (value: unknown): FlowOutcome => {
    const known = FLOW_OUTCOMES.find((outcome) => outcome === value);
    return known ?? 'notice';
};
