import { z } from 'zod';
import { CommandHandler } from '../../../command-bus/command-bus';
import type { RenderableCommandResult } from '../../../command-bus/command-reply';
import { inAppCopy } from '../../../bot-surface/miniapp/inapp-copy';
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
 * command existed nothing in any of the three repositories read that message type.
 *
 * ── WHAT EACH COMPLETION NEEDS FROM THE CHAT ────────────────────────────────
 *   · **listing, a product chosen** → the chat opens that product's detail screen. This is the
 *     one completion that asks for something next.
 *   · **detail and checkout** → nothing. Their forms show the outcome on a closing screen
 *     before they close (added to the basket, go to the chat to bargain, approve the payment on
 *     your phone), and the payment result reaches the chat through the payment path. A second
 *     "got that" here would talk over the message the customer is actually waiting for.
 *   · **any notice screen** ("nothing here", "no saved address") → nothing, for the same reason.
 *
 * ── ⚠ THE TOKEN MAY ALREADY BE SPENT, AND THAT IS SUCCESS, NOT FAILURE ──────
 * The checkout's terminal exchange spends its handle. Meta then sends the completion with the
 * same `flow_token`, which is gone by design. Refusing an unresolvable token here would tell
 * every customer whose order succeeded that it failed. So the Flow's own `screen` stamp decides
 * which Flow finished, and a spent token is never an error.
 *
 * ── ⚠ IT MINTS A VIEW SESSION, AND ONLY UNDER THREE CONDITIONS ─────────────
 * Opening the detail screen means minting a `pd` handle, which is a write. It is bounded
 * tightly, because the completion message is relayed by the automation layer and could be
 * replayed:
 *   1. the **listing session is still live** (read, never consumed or touched), so a replay of
 *      an old message mints nothing once its thirty minutes are up;
 *   2. the **sender is the conversation that session was minted for**, so a completion that
 *      arrives from anyone else opens nothing and says nothing;
 *   3. the new session inherits the listing session's owner, customer, channel, conversation
 *      and language. **None of those comes from the payload**, which is caller-supplied.
 * A `pd` handle authorises viewing a product and starting a purchase from the form. It places
 * nothing, pays nothing and adds nothing. **This command never consumes, never adds to a
 * basket and never places an order**; that stays in the encrypted exchange, where the session
 * is live and the retry guard sits.
 */

/**
 * ⚠ **`.passthrough()`, not `.strict()`, and this is the one place on the bot side where that is
 * right.** Every Flow puts its own params in the completion; a strict schema would reject a
 * Flow published later. The bot surface's envelope is `.strict()` for the opposite and stronger
 * reason: there, an unknown key could be a caller-supplied identity. Nothing here reads an
 * identity from the payload.
 */
export const schema = z
    .object({
        /** The `ia_…` handle. Optional: a spent handle and a dropped field are both normal. */
        flow_token: z.string().optional(),
        /** Which Flow finished, stamped by its definition. */
        screen: z.string().optional(),
    })
    .passthrough();

export interface FlowCompleteReply extends RenderableCommandResult {
    message: string;
    /** Which Flow finished, where it could be established. Named apart from `screen`, which opens one. */
    completedScreen: InAppSurfaceKind | null;
    /** The completion params, minus the token. */
    params: Record<string, unknown>;
}

const isKind = (value: string): value is InAppSurfaceKind =>
    value === 'pl' || value === 'pd' || value === 'ol' || value === 'sl' || value === 'co';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Digits only, so `+237 6…`, `2376…` and a bare-digits `wa_phone_id` compare equal. */
const digitsOf = (value: string | null | undefined): string =>
    typeof value === 'string' ? value.replace(/\D/g, '') : '';

export type CompletionPlan =
    | { kind: 'open_detail'; productId: string }
    /** The listing session has lapsed: say so, in words, and open nothing. */
    | { kind: 'expired' }
    /** Nothing for the chat to add. */
    | { kind: 'silent' };

/**
 * What a completion should lead to. **Pure**, so every branch is asserted without Redis.
 *
 * ⚠ **A sender mismatch is SILENT, not "expired".** Telling a stranger the listing lapsed would
 * confirm that a handle they don't own was real. Silence tells them nothing.
 */
export function planCompletion(input: {
    completedScreen: InAppSurfaceKind | null;
    params: Record<string, unknown>;
    /** `wa_phone_id` from the command CONTEXT, never from the payload. */
    sender: string | null;
    /** The live listing session, or null when it lapsed or there was no token. */
    session: { channel: string; externalId: string } | null;
}): CompletionPlan {
    if (input.completedScreen !== 'pl') return { kind: 'silent' };
    if (input.params.outcome === 'notice') return { kind: 'silent' };

    const productId = input.params.productId;
    if (typeof productId !== 'string' || !OBJECT_ID.test(productId)) return { kind: 'silent' };

    if (!input.session) return { kind: 'expired' };

    const sender = digitsOf(input.sender);
    if (
        input.session.channel !== 'whatsapp'
        || sender === ''
        || sender !== digitsOf(input.session.externalId)
    ) {
        return { kind: 'silent' };
    }

    return { kind: 'open_detail', productId };
}

export const handler: CommandHandler<z.infer<typeof schema>, FlowCompleteReply> = async (
    payload,
    context,
) => {
    const { flow_token: flowToken, screen: declaredScreen, ...params } = payload;
    const completedScreen: InAppSurfaceKind | null =
        declaredScreen && isKind(declaredScreen) ? declaredScreen : null;

    /**
     * Read only for a listing completion, and with the kind named: `read('pl', …)` refuses a
     * `pd` or `co` handle by construction. It is `read`, never `touch`, so a completion can't
     * extend a session's life.
     */
    const session =
        completedScreen === 'pl' && flowToken
            ? await inAppSurfaceStore.read('pl', flowToken)
            : null;

    const plan = planCompletion({
        completedScreen,
        params,
        sender: typeof context?.wa_phone_id === 'string' ? context.wa_phone_id : null,
        session,
    });

    const base = { completedScreen, params };

    if (plan.kind === 'silent') return { ...base, message: '' };

    if (plan.kind === 'expired') {
        // The session and its language are gone together, so this is English. See
        // `flow-screens.ts` `tokenUnusable` for the same limit on the endpoint.
        return { ...base, message: inAppCopy(null).expired };
    }

    const listing = session!;
    const handle = await inAppSurfaceStore.mint({
        kind: 'pd',
        owner: listing.owner,
        customerId: listing.customerId,
        channel: listing.channel,
        externalId: listing.externalId,
        language: listing.language,
        productId: plan.productId,
    });

    return {
        ...base,
        message: '',
        language: listing.language,
        /**
         * The same inputs as the chat's own product door (`POST /inapp/products/:productId`):
         * kind `pd`, the `openButton` label, and no storefront fallback, for that door's
         * reason (a product URL needs two slugs this command doesn't hold).
         */
        screen: { kind: 'pd', handle, labelKey: 'openButton', fallbackPath: null },
    };
};
