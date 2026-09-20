import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { parseBotActionId } from '../domain/bot-action-id';
import { actionKeyOf, mergeActionHandlers, unknownBotAction } from '../domain/bot-action-dispatch';
import { BotDisplayActionSchema } from '../validators/bot.validators';
import { PURCHASE_ACTION_HANDLERS } from './bot-purchase.controller';
import { ORDER_ACTION_HANDLERS } from './bot-order.controller';
import { CHECKOUT_ACTION_HANDLERS } from './bot-checkout.controller';
import { ACCOUNT_ACTION_HANDLERS } from './bot-account.controller';
import { DISCOVERY_ACTION_HANDLERS } from './bot-discovery.controller';
import { BARGAIN_ACTION_HANDLERS } from './bot-negotiation.controller';
import { DIGITAL_ACTION_HANDLERS } from './bot-catalog.controller';

/**
 * THE TAP-CODE DISPATCHER — `POST /catalog/action`, the surface's single tap handler.
 *
 * ── WHAT COMES THROUGH HERE ─────────────────────────────────────────────────
 * Every button this service draws, on either channel: Telegram returns it as
 * `callback_query.data`, WhatsApp as `interactive.button_reply.id`, and the automation layer
 * forwards the token verbatim and parses nothing (`bot-surface.md` § 14.6). The route's tool name,
 * `catalog_display_action`, is historical — this is not a catalogue-only door, and has not been
 * since the first non-product verb.
 *
 * ── A THIN SHELL, ON PURPOSE ────────────────────────────────────────────────
 * The whole routing decision — which verbs are shared, how a sub-key is split off, and the refusal
 * of a key claimed twice — is in `domain/bot-action-dispatch.ts` as pure functions. This file only
 * holds the registry and calls them. That split is what lets the rules be proven by a suite that
 * could never import THIS file: every stream's handlers reach `orders/` or `payments/`, which hang
 * bare `ts-node` at import with no output at all.
 *
 * ── ⚠ AN UNHANDLED KEY IS THE DESIGNED STATE, NOT A BUG ─────────────────────
 * The vocabulary in `bot-action-id.ts` is declared AHEAD of its handlers, so a string is frozen
 * before any button carrying it reaches a chat history — where it stays forever. Until a key's
 * handler is registered below, its token is refused with a sentence. No button carrying an
 * unregistered key should be drawn; if one is, that sentence is what the customer gets instead of
 * silence.
 */

/**
 * ⭐ **THE REGISTRY — one line per stream, every routed key visible from here.**
 *
 * A stream's keys arrive by contract request to the registry's owner, who adds its line; the
 * stream only exports its map and never opens this file. Merged at MODULE IMPORT — which is also
 * boot — so two streams claiming one key stops the process, naming both, before any customer
 * taps anything.
 */
const HANDLERS = mergeActionHandlers([
    /** add · buy · bargain · book · next · more · cart · open:co · open:pl */
    ['purchase', PURCHASE_ACTION_HANDLERS],
    /** ord · shp · code · track · tkt · yes:cd · no:cd · yes:cnc · no:cnc · open:ol */
    ['orders', ORDER_ACTION_HANDLERS],
    /** pay (pay:st Check status · pay:rt Try again) */
    ['checkout', CHECKOUT_ACTION_HANDLERS],
    /**
     * acct · lang · yes:close · no:close · yes:unl · no:unl
     *
     * ⚠ **Registered a round late, and the gap is the lesson.** The close preview drew both
     * buttons from 6b2a47d while this line was missing, so each tap answered the unknown-token
     * sentence. Nothing proved a DRAWN key was ROUTED — only that no key was routed twice.
     *
     * ⚠ `lang` is a CLAIM on a verb that already existed: `languageActionId` has shipped since
     * milestone 1 with nothing drawing it and nothing handling it. The four keys after `acct`
     * arrive with the handlers that draw them, in one change each, for the reason above.
     */
    ['account', ACCOUNT_ACTION_HANDLERS],
    /**
     * cat · sim · save · open:pd
     *
     * ⚠ `open:pd` is the fourth screen sub-key and the three owners are deliberately apart:
     * purchase holds `open:co` and `open:pl`, orders holds `open:ol`. The pair guard below is
     * what makes that separation enforced rather than agreed.
     */
    ['discovery', DISCOVERY_ACTION_HANDLERS],
    /** deal — accepting a price the bargaining agent offered in one numbered round. */
    ['bargain', BARGAIN_ACTION_HANDLERS],
    /**
     * dl — hand over a purchased file.
     *
     * ⚠ **Registered the moment the button existed, and the guard is why.** `test-bot-surface`
     * § 20 reported `downloadActionId() emits "dl:" and no handler map claims it` while this
     * line was missing — a live, in-flight instance of the close-account defect, caught before
     * a customer met it rather than after.
     */
    ['digital', DIGITAL_ACTION_HANDLERS],
]);

export class BotActionController {
    /**
     * `POST /catalog/action` — parse once, resolve the key, route, or refuse in one place.
     *
     * ⚠ **The body schema is still `BotDisplayActionSchema`**, a `.strict()` object holding one
     * token of at most 128 characters. It is reused rather than renamed because the automation
     * layer's contract is `{ "token": "…" }` and nothing about that changed; only who answers it
     * did.
     */
    static dispatch = asyncHandler(async (req: Request, res: Response) => {
        /**
         * ⚠ **The caller is resolved at the DOOR, before any stream's code runs.** Every handler
         * behind this dispatcher assumes a resolved customer, and each still reads it with
         * `botCallerOf` itself — but resolving it here too makes that a property of the door
         * rather than of every handler remembering. If this route were ever mounted without
         * `requireBotIdentity`, the wiring fault surfaces once, here, before a token is even
         * parsed, instead of halfway through whichever stream's handler happened to be tapped.
         *
         * The value is discarded on purpose: the call IS the check, and it throws.
         */
        botCallerOf(req);

        const { token } = BotDisplayActionSchema.parse(req.body ?? {});

        const parsed = parseBotActionId(token);
        if (!parsed) throw unknownBotAction();

        const { key, action } = actionKeyOf(parsed);
        const handler = HANDLERS[key];

        /**
         * ⚠ **One refusal for every way a tap can route nowhere** — an unknown verb (caught
         * above), an unknown sub-key, and a key declared in the vocabulary whose handler has not
         * landed yet. From where the customer sits all three are the same event.
         */
        if (!handler) throw unknownBotAction();

        await handler(req, res, action);
    });
}
