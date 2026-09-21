import type { InAppSurfaceKind } from '../../../bot-surface/services/inapp-surface.store';
import { asFlowOutcome } from '../domain/flow-outcome';

/**
 * What a finished WhatsApp form should lead to in the conversation. **Pure**, so every branch is
 * asserted without Redis, a catalogue or a command bus.
 *
 * ── ⚠ WHY THIS IS A SIBLING MODULE AND NOT PART OF THE COMMAND ──────────────
 * The handler renders these plans, and rendering an "added to cart" answer means reaching the
 * chat's own three controls — which live in a controller that reaches `orders/` and `payments/`.
 * Those do work at import that never returns under the bare `ts-node` the suites run on, so a
 * suite importing the handler would print nothing at all and read as a broken test. The decision
 * therefore lives here, where a suite can drive it, and the handler is scanned as text. That is
 * this repository's standing pattern, not a local trick.
 */

export type CompletionPlan =
    /** A listing choice: open that product's detail screen. */
    | { kind: 'open_detail'; productId: string }
    /**
     * The basket changed inside the form. The chat repeats it and offers the same three controls
     * a chat-tap "added to cart" offers — because on WhatsApp the screen's own controls are gone
     * the moment it closes.
     */
    | { kind: 'added_to_cart' }
    /**
     * The form asked a QUESTION the customer answers by typing — a bargain or a booking — and on
     * WhatsApp that question was visible only on a screen that has now closed. The chat carries it
     * into the conversation, where it can still be answered.
     *
     * ⚠ **The product is named, not the verb.** Which rung the product is on is re-resolved from
     * the live catalogue when the answer is composed: a bargaining window that closed in the
     * meantime must not be invited into.
     */
    | { kind: 'invite_reply'; productId: string }
    /**
     * An appointment was made or moved. The chat acknowledges it — content-free, plus a **My
     * bookings** button — because the platform's own booking notification picks ONE secondary
     * channel (telegram > email > whatsapp) and is mutable by a preference, so a WhatsApp
     * customer with a verified email could finish the form and hear nothing in the conversation
     * they booked from.
     *
     * ⚠ **`moved` carries through**, because telling somebody their appointment is "booked" when
     * they moved one reads as a second appointment. It comes from the SESSION's own knowledge —
     * a `bk` handle that named a booking to move — never from anything the form sent.
     */
    | { kind: 'booking_ack'; moved: boolean }
    /** The session has lapsed: say so, in words, and open nothing. */
    | { kind: 'expired' }
    /** Nothing for the chat to add. */
    | { kind: 'silent' };

/** Digits only, so `+237 6…`, `2376…` and a bare-digits `wa_phone_id` compare equal. */
const digitsOf = (value: string | null | undefined): string =>
    typeof value === 'string' ? value.replace(/\D/g, '') : '';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export interface CompletionSession {
    channel: string;
    externalId: string;
    /** Present on a `pd` session: the product the form was opened for. */
    productId?: string;
}

/**
 * ⚠ **A sender mismatch is SILENT, not "expired".** Telling a stranger the listing lapsed would
 * confirm that a handle they don't own was real. Silence tells them nothing.
 */
const fromThisConversation = (session: CompletionSession, sender: string | null): boolean => {
    const digits = digitsOf(sender);
    return session.channel === 'whatsapp' && digits !== '' && digits === digitsOf(session.externalId);
};

export function planCompletion(input: {
    completedScreen: InAppSurfaceKind | null;
    params: Record<string, unknown>;
    /** `wa_phone_id` from the command CONTEXT, never from the payload. */
    sender: string | null;
    /** The live session for the form that finished, or null when it lapsed or there was no token. */
    session: CompletionSession | null;
}): CompletionPlan {
    const outcome = asFlowOutcome(input.params.outcome);

    /**
     * The product form. Its exchange already did whatever was going to be done, while the session
     * was live and the retry guard held; what is left is telling the conversation.
     */
    if (input.completedScreen === 'pd') {
        /**
         * ⛔ **The question the customer must answer by typing.** A bargain or a booking writes
         * nothing: it starts a conversation, and the automation layer's agent wakes on the
         * customer's NEXT INBOUND MESSAGE and on nothing else. On Telegram that question is pushed
         * into the thread; on WhatsApp it existed only on the closing screen, so it died with it —
         * and a question nobody can see is a question nobody answers.
         *
         * ⚠ **Both bounds are required here**, unlike an add. The answer names a product, so a
         * lapsed session (no product to name) says the page is gone, and a completion from
         * another conversation says nothing at all.
         */
        if (outcome === 'asked') {
            if (!input.session?.productId) return { kind: 'expired' };
            if (!fromThisConversation(input.session, input.sender)) return { kind: 'silent' };
            return { kind: 'invite_reply', productId: input.session.productId };
        }

        if (outcome !== 'added') return { kind: 'silent' };

        /**
         * ⚠ **A lapsed session still gets the answer, and that is deliberate.** A form can only
         * stamp `added` after the purchase core returned, inside a live session — so the basket
         * really did change. Thirty minutes later the session is gone and there is nothing left
         * to compare a sender against; the sentence discloses nothing, and the three controls
         * resolve against whoever is actually asking, never against the lapsed session. Silence
         * here would cost a real customer their basket's only remaining door.
         */
        if (input.session && !fromThisConversation(input.session, input.sender)) {
            return { kind: 'silent' };
        }
        return { kind: 'added_to_cart' };
    }

    /**
     * The booking form. Its receipt was shown on the closing screen while the session was live;
     * this is the conversation's own acknowledgement, and it names nothing about the appointment.
     */
    if (input.completedScreen === 'bk') {
        if (outcome !== 'booked' && outcome !== 'moved') return { kind: 'silent' };
        /**
         * ⚠ **No sender check is possible and none is needed.** `confirmBooking` consumed the
         * handle, so there is no session left to compare against — and the sentence discloses
         * nothing, while the button resolves against whoever is actually asking rather than
         * against the completion.
         */
        return { kind: 'booking_ack', moved: outcome === 'moved' };
    }

    if (input.completedScreen !== 'pl') return { kind: 'silent' };

    /**
     * ⚠ **Told apart by the STAMP, not by the outcome's value.** The listing's own screen hands
     * back a `productId` and stamps nothing; the closing screen stamps an outcome and hands back
     * no product. So any stamp at all on a listing completion means the notice closed — the
     * customer left without choosing, and the chat has nothing to add.
     */
    if (input.params.outcome !== undefined) return { kind: 'silent' };

    const productId = input.params.productId;
    if (typeof productId !== 'string' || !OBJECT_ID.test(productId)) return { kind: 'silent' };

    if (!input.session) return { kind: 'expired' };
    if (!fromThisConversation(input.session, input.sender)) return { kind: 'silent' };

    return { kind: 'open_detail', productId };
}
