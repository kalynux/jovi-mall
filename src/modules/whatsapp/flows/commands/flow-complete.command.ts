import { z } from 'zod';
import { CommandHandler } from '../../../command-bus/command-bus';
import {
    InAppSurfaceKind,
    inAppSurfaceStore,
} from '../../../bot-surface/services/inapp-surface.store';

export const command_name = 'flow_complete';

/**
 * `flow_complete` — a customer finished a WhatsApp Flow.
 *
 * ── ⛔ THE GAP THIS CLOSES: A FORM THAT SUBMITTED INTO SILENCE ──────────────
 * A Flow's result does **not** come back on the encrypted data endpoint. It arrives in the
 * conversation as an ordinary inbound message of type `interactive.nfm_reply`, and until this
 * command existed **nothing in any of the three repositories read that message type** —
 * verified by scanning all of `src/` for `nfm_reply`, `response_json` and `flow_reply`: zero
 * hits. So a customer could open a form, fill it in, press the final button, and the thread
 * would say nothing at all.
 *
 * That was in nobody's scope: not Stream F's brief, not Streams A–E, not the deferred list.
 * It is here because it is meaningless anywhere else — the session identity a completion
 * carries is the in-app handle, and this module is what mints and reads those.
 *
 * ── ⚠ THE TOKEN MAY ALREADY BE SPENT, AND THAT IS SUCCESS, NOT FAILURE ──────
 * **This is the single rule most likely to be got backwards, and getting it backwards makes
 * every successful checkout report a failure to the customer.**
 *
 * The checkout Flow's terminal exchange reaches the data endpoint, which calls
 * `inAppSurfaceStore.consume` — deliberately, because single use on the write is what stops a
 * double-tap placing two orders. Meta *then* sends the completion message carrying the same
 * `flow_token`. By that point the handle is gone, correctly and by design.
 *
 * So an unresolvable token here means one of two opposite things and cannot distinguish them:
 * a checkout that **worked**, or a stale forwarded message. The safe reading is the first,
 * because the second costs nothing and misreporting the first tells somebody their order
 * failed when their money has moved. Hence: the **params are the record** and the token is
 * only ever a correlation hint.
 *
 * ⚠ Do not "fix" this by refusing an unresolved token. The obvious hardening is exactly the
 * defect.
 *
 * ── WHY IT TRUSTS THE PARAMS, AND WHAT BOUNDS THAT ──────────────────────────
 * The params are whatever the endpoint put in `extension_message_response` — our own text,
 * round-tripped through Meta and the automation layer. They are not customer input and they
 * name no account: nothing here reads an id out of them and acts on it. The one thing this
 * command does with a resolvable token is confirm which **screen** completed, and a token
 * that resolves came from `inAppSurfaceStore`, which minted it against one conversation.
 *
 * ⚠ **It performs NO write of its own.** Nothing here places an order, spends a credential or
 * changes state — the endpoint already did whatever was going to be done, inside the
 * encrypted exchange, where the session was live. This command reports. A write here would be
 * a second, unauthenticated path to the same effect, reachable by replaying an old message.
 */

/**
 * ⚠ **`.passthrough()`, not `.strict()`, and this is the one place on the bot side where that
 * is right.** Every Flow puts its own params in the completion, and they differ per screen; a
 * strict schema would have to name all of them and would reject a Flow published later. The
 * bot surface's envelope is `.strict()` for the opposite and stronger reason — there, an
 * unknown key could be a caller-supplied identity.
 */
export const schema = z
    .object({
        /**
         * The `ia_…` handle the screen was opened with.
         *
         * ⚠ **Optional, because a spent handle is a normal outcome** (see the header) and
         * because Meta is the party that echoes it — if routing drops it, the completion is
         * still worth reporting. Never treat its absence as an authorisation failure.
         */
        flow_token: z.string().optional(),
        /** Which screen finished, stamped by the Flow definition itself. */
        screen: z.string().optional(),
    })
    .passthrough();

export interface FlowCompleteReply {
    message: string;
    /** The screen that completed, where it could be established. For the caller's routing. */
    screen: InAppSurfaceKind | null;
    /** The completion params, minus the token. Passed through for the caller to act on. */
    params: Record<string, unknown>;
}

/**
 * Which kind a still-live handle belongs to.
 *
 * ⚠ **`read` demands the kind it expects and refuses a mismatch** — that check is the whole
 * reason a forwarded listing handle cannot be replayed against checkout, so it must not be
 * weakened. Asking each kind in turn preserves it exactly: every call is still kind-checked,
 * and the loop only discovers which check passes.
 *
 * `co` is deliberately **absent from the list**: a checkout handle is consumed by the write
 * that places the order, so it can never resolve here, and asking would spend a Redis round
 * trip to learn nothing. Its completion is identified by the params instead.
 */
const RESOLVABLE_KINDS: readonly InAppSurfaceKind[] = ['pl', 'pd', 'ol', 'sl'];

async function kindOf(handle: string): Promise<InAppSurfaceKind | null> {
    for (const kind of RESOLVABLE_KINDS) {
        if (await inAppSurfaceStore.read(kind, handle)) return kind;
    }
    return null;
}

const isKind = (value: string): value is InAppSurfaceKind =>
    value === 'pl' || value === 'pd' || value === 'ol' || value === 'sl' || value === 'co';

export const handler: CommandHandler<z.infer<typeof schema>, FlowCompleteReply> = async (
    payload,
) => {
    const { flow_token: flowToken, screen: declaredScreen, ...params } = payload;

    /**
     * The Flow's own stamp is preferred over a store lookup, and deliberately so: it is
     * present for **every** completion including a spent checkout, where the lookup cannot
     * answer at all. The store is the fallback, for a completion whose routing lost the stamp.
     */
    let screen: InAppSurfaceKind | null =
        declaredScreen && isKind(declaredScreen) ? declaredScreen : null;

    if (!screen && flowToken) {
        screen = await kindOf(flowToken);
    }

    /**
     * ⚠ **English, like every other command reply on this surface, and for the stated
     * reason** — `command-reply.ts` records that the command surface is English-only outbound
     * because at command time there is often no account to read `preferred_language` from.
     * Here there IS one, so this is the first command that could localise; doing it in
     * isolation would put one localised sentence among four English ones. Flagged rather than
     * half-done.
     */
    return {
        message: 'Thanks — got that.',
        screen,
        params,
    };
};
