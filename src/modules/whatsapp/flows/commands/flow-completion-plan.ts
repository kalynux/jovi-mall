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
    /** The listing session has lapsed: say so, in words, and open nothing. */
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
