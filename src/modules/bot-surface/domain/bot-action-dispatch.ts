import type { Request, Response } from 'express';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import type { BotActionVerb } from './bot-action-id';

/**
 * THE CONTRACT BETWEEN THE TAP-CODE DISPATCHER AND THE STREAMS WHOSE BUTTONS IT ROUTES.
 *
 * ── WHY THE DISPATCHER EXISTS ───────────────────────────────────────────────
 * Every button this surface draws, on either channel, comes back through ONE route —
 * `POST /catalog/action` — because the automation layer forwards the token verbatim and parses
 * nothing (`bot-surface.md` § 14.6). That single door is right, and it created a problem the
 * moment a second stream needed a verb: the door was a `switch` inside one stream's controller,
 * so adding an order button meant editing the purchase stream's file. In one working tree with
 * no branching, two sessions editing one file is a LOST WRITE, not a merge conflict.
 *
 * So the door does only the two jobs that must happen exactly once — **parse the token, and
 * refuse what nobody handles** — and each stream EXPORTS its handlers and never opens it.
 *
 * ── THE ROUTING RULE (decided 2026-09-16, for every stream) ──────────────────
 * A token is `<verb>:<argument>`. Most verbs have exactly one owning stream and are routed by the
 * VERB alone. Three verbs are shared by design and are routed by a **(verb, sub-key) pair**:
 *
 *     token                          registry key     the handler receives
 *     ─────────────────────────────  ───────────────  ─────────────────────────────────────
 *     ord:<orderId>                  ord              verb ord,  argument <orderId>
 *     open:co                        open:co          verb open, subKey co,  argument ''
 *     open:pd:<productId>            open:pd          verb open, subKey pd,  argument <productId>
 *     yes:cd:<orderId>:<shipmentId>  yes:cd           verb yes,  subKey cd,  argument <orderId>:<shipmentId>
 *
 *   - **`open`** — one verb for every in-app screen, so the sub-key is the SURFACE, and each
 *     surface has one owner. The purchase stream opens checkout; the orders stream opens history.
 *   - **`yes` / `no`** — the universal confirm pair, so the sub-key is the CONTEXT, which names
 *     what is being agreed to. Confirming a delivery and closing an account are different streams'
 *     decisions that happen to share a button word.
 *
 * ⚠ **Only those three.** A verb one stream owns stays keyed by the verb even when its arguments
 * have several shapes — `shp:<orderId>` and `shp:<orderId>:<shipmentId>`, `tkt:<ticketId>` and
 * `tkt:new:…` — and the owning handler tells them apart. Sub-dispatching a verb nobody shares
 * would put a stream's internal argument grammar into the shared registry, where the next change
 * to it becomes somebody else's edit.
 *
 * ── WHY THE RULES LIVE HERE AS PURE FUNCTIONS ───────────────────────────────
 * `actionKeyOf` and `mergeActionHandlers` are the entire routing decision, and neither touches a
 * request, a database or a controller. The dispatcher is a thin shell over them. That is what lets
 * the one property that must never silently fail — **two streams claiming one key throws, and
 * names both** — be proven by calling it, in a suite that could never import the dispatcher itself
 * (controllers reach `orders/` and `payments/`, which hang bare `ts-node` at import).
 */

/**
 * The verbs routed by a sub-key rather than by the verb alone.
 *
 * ⚠ **Adding a verb here is a registry-wide decision, not a stream's.** It changes the key of
 * every handler registered under that verb, so a verb that one stream already owns outright would
 * silently stop routing the day it was added.
 */
export const SUB_DISPATCHED_VERBS = Object.freeze(['open', 'yes', 'no'] as const);
export type SubDispatchedVerb = (typeof SUB_DISPATCHED_VERBS)[number];

const isSubDispatched = (verb: string): verb is SubDispatchedVerb =>
    (SUB_DISPATCHED_VERBS as readonly string[]).includes(verb);

/**
 * A registry key: a plain verb, or a shared verb with its sub-key.
 *
 * ⚠ **The type refuses the two mistakes that would route nowhere.** A bare `yes` is not a key —
 * it would shadow every context under it — and neither is a misspelt `yse:cd`, which matches no
 * pattern. Both are compile errors in a stream's export rather than buttons that do nothing.
 */
export type BotActionKey = Exclude<BotActionVerb, SubDispatchedVerb> | `${SubDispatchedVerb}:${string}`;

/**
 * A token already split and resolved against the routing rule.
 *
 * ⚠ **Handlers receive it resolved and must never re-read `req.body.token`.** Parsing once is the
 * whole point: a handler that re-parsed could disagree with the dispatcher about what was pressed,
 * and the refusal for a malformed token would stop being in one place.
 */
export interface ParsedBotAction {
    verb: BotActionVerb;
    /**
     * The surface or context, for the three shared verbs — `co`, `ol`, `cd`, `cnc`. Absent on
     * every other verb. A handler registered under a pair already knows its own sub-key; it is
     * carried for handlers registered under several pairs and for logging.
     */
    subKey?: string;
    /**
     * What the handler interprets: everything after the verb, or — for a shared verb —
     * everything after the sub-key.
     *
     * ⚠ **May be EMPTY on a shared verb** (`open:co`, `open:ol` carry no reference). On a plain
     * verb it is never empty, because `parseBotActionId` refuses a token with no argument.
     */
    argument: string;
}

/**
 * What a stream exports for each key it owns.
 *
 * ⚠ **A handler must END THE REQUEST on every path** — `sendSuccess`, or a thrown `AppError` that
 * the dispatcher's `asyncHandler` forwards to the global handler. Returning without either leaves
 * the automation layer waiting until it times out, and the customer who tapped sees nothing.
 *
 * ⚠ **THROW. Never call `next`, and never await another route's `asyncHandler`-wrapped static.**
 * Awaiting one of those resolves before the work finishes, and its own `.catch(next)` swallows the
 * error — a tap that produces no message and no log line. That exact mistake has already been made
 * once on this surface.
 *
 * ⚠ **An argument a handler cannot read gets `unknownBotAction()`** — the same refusal the
 * dispatcher gives for an unknown verb — so a malformed `ord:` and a retired `zzz:` read
 * identically to the customer. Both carry `error.customerMessage`.
 */
export type BotActionHandler = (
    req: Request,
    res: Response,
    action: ParsedBotAction,
) => Promise<void>;

/**
 * A stream's contribution to the registry — ONE map per stream, holding plain verbs and pairs
 * side by side.
 *
 * `Partial` because no stream owns every key, and because the vocabulary is deliberately declared
 * ahead of its handlers (`bot-action-id.ts`).
 */
export type BotActionHandlers = Partial<Record<BotActionKey, BotActionHandler>>;

/**
 * THE refusal for a tap nobody can act on — an unknown verb, an unknown sub-key, an unhandled key,
 * or an argument its handler cannot read.
 *
 * ⚠ **One factory, so the refusal is DEFINED in one place and not merely raised from one.** If the
 * dispatcher and a handler each built their own `createAppError`, the two would drift the first
 * time somebody changed a status or a message, and the customer would get two different answers to
 * what is, from where they sit, one event: they tapped something and it did nothing.
 *
 * ⚠ **422, never a 404 or a 500.** A button lives in a chat history for as long as the conversation
 * does, so a tap on one whose verb a deploy has retired is an ORDINARY event rather than a fault —
 * and `BOT_ACTION_TOKEN_UNKNOWN` carries `error.customerMessage`, which is what turns the tap into a
 * sentence. Telegram reports no error for an unhandled callback, so without that sentence the
 * customer taps and the world is silent, forever.
 */
export function unknownBotAction() {
    return createAppError(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, 422, 'Unrecognised action token');
}

/**
 * Resolve a parsed token to the registry key it routes by, and the action its handler receives.
 *
 * Splits a shared verb's argument at the FIRST colon only, so a reference that itself contains
 * colons (`yes:cd:<orderId>:<shipmentId>`) reaches the handler intact.
 *
 * ⚠ **An empty sub-key (`yes::x`) produces the key `yes:`**, which no stream can register —
 * `mergeActionHandlers` refuses it — so it falls to the one unknown-token refusal rather than to a
 * special case here.
 */
export function actionKeyOf(parsed: { verb: BotActionVerb; argument: string }): {
    key: string;
    action: ParsedBotAction;
} {
    if (!isSubDispatched(parsed.verb)) {
        return { key: parsed.verb, action: { verb: parsed.verb, argument: parsed.argument } };
    }

    const colon = parsed.argument.indexOf(':');
    const subKey = colon < 0 ? parsed.argument : parsed.argument.slice(0, colon);
    const argument = colon < 0 ? '' : parsed.argument.slice(colon + 1);

    return {
        key: `${parsed.verb}:${subKey}`,
        action: { verb: parsed.verb, subKey, argument },
    };
}

/**
 * Merge every stream's handlers into one registry, REFUSING any key claimed twice.
 *
 * ⚠ **The guard runs over the KEY — the pair, for a shared verb — not over the verb.** Two streams
 * legitimately own `yes:cd` and `yes:close`; two streams claiming `yes:cd` is a silent overwrite in
 * which the later spread wins and one stream's button quietly starts running the other stream's
 * code. So a duplicate throws, and names both streams and the key, so the fix is obvious.
 *
 * ⚠ **Also refuses the two keys the type already forbids**, because a map built with `as any` or
 * assembled at runtime bypasses the type: a BARE shared verb (`yes`) would shadow every context
 * under it, and an empty sub-key (`yes:`) could only ever be reached by a malformed token.
 *
 * Called once, at MODULE IMPORT of the dispatcher, which is also at boot — exactly like
 * `assertHandlersCoverRoutes()` in `bot.routes.ts`, and for the same reason: a wiring mistake must
 * stop the process for the session that made it rather than reach a customer as a wrong button.
 */
export function mergeActionHandlers(
    streams: ReadonlyArray<readonly [stream: string, handlers: BotActionHandlers]>,
): Readonly<Record<string, BotActionHandler>> {
    const owners = new Map<string, string>();
    const merged: Record<string, BotActionHandler> = {};

    for (const [stream, handlers] of streams) {
        for (const [key, handler] of Object.entries(handlers)) {
            /**
             * ⚠ **Skipped FIRST, before any claim is recorded.** `Partial` permits an explicit
             * `undefined`, and an entry holding no handler is not a claim — counting it as one
             * would refuse a legitimate owner for a key the other stream never actually handles.
             */
            if (typeof handler !== 'function') continue;

            if (isSubDispatched(key)) {
                // eslint-disable-next-line no-restricted-syntax -- wiring fault at boot, not a request outcome
                throw new Error(
                    `[BotSurface] stream "${stream}" registers the bare shared verb "${key}" — `
                    + `it must register "${key}:<sub-key>" so other streams can share the verb`,
                );
            }

            const [verb, subKey] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
            if (key.includes(':') && isSubDispatched(verb) && subKey.length === 0) {
                // eslint-disable-next-line no-restricted-syntax -- wiring fault at boot, not a request outcome
                throw new Error(`[BotSurface] stream "${stream}" registers "${key}" with an empty sub-key`);
            }

            const previous = owners.get(key);
            if (previous) {
                // eslint-disable-next-line no-restricted-syntax -- wiring fault at boot, not a request outcome
                throw new Error(
                    `[BotSurface] tap key "${key}" is claimed by both "${previous}" and "${stream}" — `
                    + 'every key must have exactly one handler',
                );
            }

            owners.set(key, stream);
            merged[key] = handler;
        }
    }

    return Object.freeze(merged);
}
