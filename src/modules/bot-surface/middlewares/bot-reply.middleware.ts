import { NextFunction, Request, Response } from 'express';
import { ERROR_CODES } from '../../../core/error-codes';
import { botChrome } from '../domain/bot-chrome-copy';
import { recoveryFor } from '../domain/bot-recovery-actions';
import {
    BotChannelReply,
    BotReplyIntent,
    renderBotReplies,
    renderBotReply,
} from '../domain/channel-reply';

/**
 * Put the outbound message body on every bot response — success and failure alike.
 *
 * ── WHY A RESPONSE INTERCEPTOR AND NOT A FIELD EACH CONTROLLER SETS ─────────
 * `reply` has to appear on responses this module does not write. The global error handler
 * answers for every route that throws, the rate limiter answers before any route runs, and
 * the idempotency guard replays a stored body — none of them knows what a messaging channel
 * is, and none of them should learn. Wrapping `res.json` once, at the mount, is what makes
 * *"every bot response carries a sendable body"* true by construction rather than true of
 * the routes somebody remembered.
 *
 * It is the same argument `requireBotIdentity` makes for being a `router.use`: a rule
 * enforced per-handler is a rule that is one new handler away from being false.
 *
 * ── ⚠ IT IS MOUNTED TWICE, AND BOTH MOUNTS ARE LOAD-BEARING ─────────────────
 * `bot.routes.ts` registers it before `requireBotIdentity` and again after
 * `botIdempotency`. That is not belt-and-braces; the two positions answer two requirements
 * that cannot be satisfied by one, because `res.json` wrappers run in REVERSE order of
 * installation:
 *
 *   **Before the identity guard** — because that guard REFUSES by throwing, and a
 *   `next(error)` skips every ordinary middleware after it. Mounted only downstream, the
 *   interceptor would never be installed on precisely the three refusals a chat window most
 *   needs worded (`BOT_IDENTITY_UNRESOLVED`, `NEEDS_CONTACT`, `NOT_CUSTOMER`).
 *
 *   **After the idempotency guard** — because the last wrapper installed is the first to
 *   run, so this position is what puts `reply` into the body BEFORE that guard captures it.
 *   The other way round, a replayed 200 comes back with the message silently missing: the
 *   customer is told nothing, and the log shows a success.
 *
 * ── IT NEVER OVERWRITES, WHICH IS WHAT MAKES TWO MOUNTS SAFE ────────────────
 * A body that already carries `reply` is passed through untouched — so the inner wrapper is
 * a no-op on any request that reached the outer one. It is the same property that makes an
 * idempotency replay safe, and it leaves the door open for a future handler that needs to
 * compose a reply this interceptor could not derive.
 */

/**
 * Error codes whose whole point is *"tap the button"*.
 *
 * Their copy in `bot-error-copy.ts` says so in five languages, and a sentence telling
 * somebody to tap a button that was never rendered is worse than one that just states the
 * problem. Both of these are raised on a Telegram sender with no verified number — the one
 * turn in the product where the contact keyboard is the entire remedy.
 *
 * ⚠ **Keyed on the CODE, not the category.** Every other identity refusal in the same
 * category (`BOT_IDENTITY_NOT_CUSTOMER`, `AUTH_ACCOUNT_SUSPENDED`) is a state a keyboard
 * cannot fix, and offering one there invites a tap that changes nothing.
 */
const CONTACT_KEYBOARD_CODES: readonly string[] = Object.freeze([
    ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT,
    ERROR_CODES.MAGIC_CONTACT_UNVERIFIED,
]);

/**
 * Record what this request should say to the customer.
 *
 * Controllers call this with a channel-neutral intent; the channel, the recipient and every
 * platform limit are applied at render time from the identity envelope. A controller
 * therefore never names Telegram or WhatsApp, which is the property that keeps
 * `channel-reply.ts` the only file that has to change when a platform does.
 *
 * ⚠ **Silently ignored off the bot surface** (`req.bot` absent), exactly as
 * `setBotResponseLanguage` is. A handler shared with the customer API must be able to call
 * it without asking which door it came through.
 */
export function setBotReply(req: Request, intent: BotReplyIntent | null): void {
    if (req.bot) req.bot.replyIntent = intent;
}

/**
 * The reply for a FAILED response, derived from the envelope the error handler already
 * built.
 *
 * Nothing new is worded here: `error.customerMessage` is the sentence, and this only
 * decides which widget carries it. A second copy table on the failure path is how the
 * customer ends up reading two different apologies for one fault.
 */
function errorReply(req: Request, error: Record<string, unknown>): BotChannelReply | null {
    const { channel, externalId } = req.bot!.envelope;
    const text = error.customerMessage;
    const code = error.code;

    // No customer sentence means this response never went through the bot-aware branch of
    // the error handler — a 404 from the router, say. Inventing one here would put an
    // English string in front of a customer at the one moment we are least sure what
    // happened.
    if (typeof text !== 'string' || text.length === 0) return null;

    if (typeof code === 'string' && CONTACT_KEYBOARD_CODES.includes(code)) {
        return renderBotReply(
            {
                kind: 'contact_request',
                text,
                buttonLabel: botChrome('contactButton', req.bot!.language),
            },
            channel,
            externalId,
        );
    }

    /**
     * ⭐ **THE WAY OUT** (atlas phase 11). Every refusal above this line was a correct sentence
     * and a chat window with nothing in it; `recoveryFor` decides which of the buttons this
     * surface already has can honestly be offered for this particular refusal.
     *
     * ⚠ **The table lives in its own file, and that is deliberate rather than tidiness.** This
     * middleware is read by every stream, so a table here would be a merge surface for all of
     * them; there it is one owner's file and this stays an import and one call.
     *
     * ⚠ **It still words nothing** — the rule at the top of this function holds. `recovery.text`
     * is `error.customerMessage` unchanged for every code but one, and that one
     * (`SYSTEM_MAINTENANCE_ACTIVE`) resolves out of `bot-error-copy.ts` like all the rest, so
     * there is still exactly one copy table on the failure path.
     */
    const recovery = recoveryFor({
        code: typeof code === 'string' ? code : null,
        category: typeof error.category === 'string' ? error.category : null,
        details: (error.details ?? undefined) as Record<string, unknown> | undefined,
        text,
        language: req.bot!.language,
    });

    return renderBotReply(
        recovery.actions.length > 0
            ? { kind: 'text', text: recovery.text, actions: recovery.actions }
            : { kind: 'text', text: recovery.text },
        channel,
        externalId,
    );
}

/** The body to send, with `reply` merged in — or the body unchanged when there is none. */
function withReply(req: Request, body: unknown): unknown {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
    /**
     * No identity yet.
     *
     * Reachable from the OUTER mount on anything answered before `requireBotIdentity` has
     * run — a bad service token, a missing webhook secret, a malformed envelope. There is
     * no channel and no recipient in that state, so there is nothing to address a message
     * to; the automation layer's own operator is the audience for those, and it has
     * `error.message`.
     */
    if (!req.bot) return body;

    const envelope = body as Record<string, unknown>;
    // Already carries one: an idempotency replay, or a handler that composed its own.
    if ('reply' in envelope) return envelope;

    /**
     * ⚠ **A failure is always ONE message and a success may be several.**
     *
     * The asymmetry is not an oversight. An error's reply is derived from
     * `error.customerMessage` — one sentence, one widget — and there is no failure on this
     * surface that wants a second message. A success can be a product list, which is a page
     * of cards; see `renderBotReplies`.
     */
    const rendered: BotChannelReply[] =
        envelope.success === false
            ? [errorReply(req, (envelope.error ?? {}) as Record<string, unknown>)].filter(
                  (reply): reply is BotChannelReply => reply !== null,
              )
            : req.bot!.replyIntent
                ? renderBotReplies(
                      req.bot!.replyIntent,
                      req.bot!.envelope.channel,
                      req.bot!.envelope.externalId,
                  )
                : [];

    // Absent rather than null. A caller branches on presence — the convention
    // `requestContact` already established on this surface — and a null would make
    // "nothing to say" indistinguishable from "something went wrong composing it".
    if (rendered.length === 0) return envelope;

    /**
     * ⚠ **`reply` stays a single object, ALWAYS, and `replies` is a sibling that appears
     * only when there is more than one.**
     *
     * The automation layer reads `$json.reply.channel` and `$json.reply.body` in an n8n
     * expression this repository does not own and cannot type-check. Turning that field into
     * an array would break every existing turn on both channels at once, for a feature none
     * of them uses. A caller that never learns about `replies` therefore keeps working and
     * sends the first message; one that knows about it sends the whole ordered list.
     *
     * ⚠ **Order is the rendering** — intro, then cards, then "See more". n8n's HTTP node
     * iterates its input items in order, which is what makes relaying the array verbatim
     * correct; sorting or parallelising it is not.
     */
    return rendered.length === 1
        ? { ...envelope, reply: rendered[0] }
        : { ...envelope, reply: rendered[0], replies: rendered };
}

export function attachBotReply(req: Request, res: Response, next: NextFunction): void {
    // ⚠ Installed UNCONDITIONALLY — `req.bot` is absent at the outer mount by design, and
    // the wrapper reads it at send time instead. Skipping here would put the coverage of
    // identity refusals back exactly where it was missing.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
        /**
         * Self-catching, and that is not defensiveness for its own sake. Everything below
         * this line is decoration on a response whose real work is already done — the order
         * is placed, the cart is saved. A renderer bug must degrade to "the automation
         * layer has to word this one itself", never to a 500 that undoes nothing but tells
         * the caller the operation failed.
         */
        let shaped = body;
        try {
            shaped = withReply(req, body);
        } catch (error) {
            console.error('[BotSurface] could not compose the channel reply', error);
        }
        return originalJson(shaped);
    };

    next();
}
