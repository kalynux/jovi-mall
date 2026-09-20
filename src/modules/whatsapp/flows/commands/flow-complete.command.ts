import { z } from 'zod';
import { CommandHandler } from '../../../command-bus/command-bus';
import type { RenderableCommandResult } from '../../../command-bus/command-reply';
import { botChrome } from '../../../bot-surface/domain/bot-chrome-copy';
import type { BotReplyOption } from '../../../bot-surface/domain/channel-reply';
import { addedToCartActions } from '../../../bot-surface/controllers/bot-purchase.controller';
import { inAppCopy } from '../../../bot-surface/miniapp/inapp-copy';
import {
    InAppSurfaceKind,
    inAppSurfaceStore,
} from '../../../bot-surface/services/inapp-surface.store';
import { planCompletion } from './flow-completion-plan';

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
 *   · **listing, a product chosen** → the chat opens that product's detail screen.
 *   · **the product form, having added to the basket** → the chat says so and offers the same
 *     three controls a chat-tap "added to cart" offers. ⛔ **This used to say "nothing", and
 *     that was the gap**: a Telegram customer keeps the screen's own controls, while a WhatsApp
 *     customer's form CLOSES — so the basket changed and the thread said nothing at all.
 *   · **checkout** → nothing. The payment result reaches the chat through the payment path, and
 *     a "got that" here would talk over the message the customer is waiting for.
 *   · **any notice screen** ("nothing here", "no saved address") → nothing, for the same reason.
 *
 * ── ⚠ EXACTLY ONE MESSAGE PER COMPLETION, AND IT HOLDS BY CONSTRUCTION ──────
 * There is no guard here against a duplicate, and none is needed: **Flows are WhatsApp-only, so
 * a Telegram session produces no completion at all** — the two ways a customer can be told
 * cannot both fire for one press. Telegram's screens push into the thread themselves; WhatsApp's
 * forms answer here. Each plan below resolves to at most one intent.
 *
 * ⚠ **STILL MISSING, and it is the other half of the same gap**: the bargain and booking rungs
 * ask a QUESTION the customer answers by typing, and on WhatsApp that question is visible only
 * on a screen that has closed. The closing screen already stamps `asked` for it. The chat cannot
 * answer it yet because the sentence is built inside `executePurchase` and there is no pure
 * function to call; the extraction is requested (see `flow-outcome.ts`). Until it lands, an
 * `asked` completion is SILENT — the customer keeps the words they read on the screen, and
 * nothing false is said.
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
    /** Buttons beside the message — the chat's own three, after a form added to the basket. */
    actions?: readonly BotReplyOption[];
}

const isKind = (value: string): value is InAppSurfaceKind =>
    value === 'pl' || value === 'pd' || value === 'ol' || value === 'sl' || value === 'co';

export const handler: CommandHandler<z.infer<typeof schema>, FlowCompleteReply> = async (
    payload,
    context,
) => {
    const { flow_token: flowToken, screen: declaredScreen, ...params } = payload;
    const completedScreen: InAppSurfaceKind | null =
        declaredScreen && isKind(declaredScreen) ? declaredScreen : null;

    /**
     * Read with the kind NAMED, so a handle can only ever resolve as the form that stamped it:
     * `read('pl', …)` refuses a `pd` or `co` handle by construction, and vice versa. It is
     * `read`, never `touch`, so a completion cannot extend a session's life.
     *
     * ⚠ **A `co` completion resolves nothing on purpose.** Its handle was SPENT by the write
     * that placed the order, so looking it up would find nothing and a handler that treated
     * that as a failure would tell every customer whose order succeeded that it failed.
     */
    const session =
        flowToken && (completedScreen === 'pl' || completedScreen === 'pd')
            ? await inAppSurfaceStore.read(completedScreen, flowToken)
            : null;

    const plan = planCompletion({
        completedScreen,
        params,
        sender: typeof context?.wa_phone_id === 'string' ? context.wa_phone_id : null,
        session,
    });

    const base = { completedScreen, params };
    /** The session is where a language can honestly come from; a payload is not. */
    const language = session?.language ?? null;

    if (plan.kind === 'silent') return { ...base, message: '' };

    if (plan.kind === 'expired') {
        // The session and its language are gone together, so this is English. See
        // `flow-screens.ts` `tokenUnusable` for the same limit on the endpoint.
        return { ...base, message: inAppCopy(null).expired };
    }

    /**
     * ⛔ **The form added something, and on WhatsApp its screen is already gone.**
     *
     * A Telegram customer keeps the screen's own controls; a WhatsApp customer pressed a footer
     * and the form closed. Without this the basket changed and the thread said nothing at all —
     * no confirmation, and no way to reach the basket except by typing.
     *
     * ⚠ **The SAME three controls the chat's own "added to cart" offers**, imported rather than
     * rebuilt: two doors offering different buttons for one outcome is how one of them quietly
     * loses Checkout. Nothing here writes — the purchase already happened inside the exchange.
     */
    if (plan.kind === 'added_to_cart') {
        return {
            ...base,
            message: botChrome('addedToCart', language),
            actions: addedToCartActions(language),
            language,
        };
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
