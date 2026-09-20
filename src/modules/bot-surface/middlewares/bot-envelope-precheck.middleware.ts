import { NextFunction, Request, Response } from 'express';
import { unsealBotIdentity } from '../domain/bot-identity-token';
import { BotEnvelopeSchema } from '../validators/bot.validators';

/**
 * Give a bot request just enough identity to be ANSWERED when it is refused before the bot
 * router is ever reached.
 *
 * ── ⛔ THE DEFECT THIS EXISTS FOR: A MAINTENANCE WINDOW TOLD THE CUSTOMER NOTHING ──
 * `maintenanceModeMiddleware` is mounted in `app.ts` **above** `app.use('/api', apiRouter)`,
 * which is correct — a gate that a new router can forget to join is not a gate. But it
 * refuses with `next(error)`, and a `next(error)` skips forward to the error handler without
 * ever entering `/api`. So on a refused bot request:
 *
 *   · `bot.routes.ts` never runs, so **`attachBotReply` is never installed** and `res.json`
 *     goes out unwrapped — no `reply` for the automation layer to send;
 *   · `requireBotIdentity` never runs, so `req.bot` is undefined, so the error handler's
 *     `customerMessage` branch (`req.bot ? … : undefined`) yields nothing either.
 *
 * The result was **silence**: a customer wrote to the shop during a maintenance window and
 * the bot did not answer at all. `maintenance-mode.ts` asserted in a comment that they had
 * been *"correctly served"*; that comment was corrected in the same change as this file.
 *
 * ── WHAT IT DOES, AND EVERYTHING IT DELIBERATELY DOES NOT ──────────────────
 * It reads the envelope and nothing else: the channel, the recipient, and the language hint.
 * **No database, no `service.resolve`, no route-table lookup, no customer.** Those belong to
 * `requireBotIdentity`, which still runs later and overwrites this with the full picture.
 * What is here is precisely what it takes to address a message to somebody.
 *
 * ── ⛔ IT MUST NEVER THROW, AND THAT IS THE WHOLE SAFETY ARGUMENT ───────────
 * This runs in front of **every** request that reaches the gate, including ones that are not
 * bot traffic at all and ones with a hostile body. A throw here would turn a middleware that
 * exists to improve an error message into a new way to fail a request that was fine.
 *
 * So every failure path leaves `req.bot` **undefined** and calls `next()` — which is exactly
 * the state the process was in before this file existed, and therefore degrades to the old
 * behaviour rather than to a new one. A malformed envelope, an unverifiable sealed token, a
 * body that is not an object: all of them simply mean "no reply can be addressed", which was
 * already true.
 *
 * ⚠ **`caller` stays null and `anonymous` stays false.** Nothing downstream may mistake this
 * for a resolved identity — it is not one, and it has checked nothing. `requireBotIdentity`
 * is still the only thing that authorises a request.
 */
export function attachBotEnvelope(req: Request, _res: Response, next: NextFunction): void {
    try {
        // Already stamped — a second mount, or a re-entrant route. Never overwrite a fuller
        // picture with a thinner one.
        if (req.bot) {
            next();
            return;
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const { identity: submitted } = BotEnvelopeSchema.parse(body);
        const identity = 'token' in submitted ? unsealBotIdentity(submitted.token) : submitted;

        req.bot = {
            caller: null,
            envelope: identity,
            /**
             * ⚠ **`unknown`, not a route-table lookup.** The tool name is for the idempotency
             * scope and the audit, and this request is on its way to a refusal that will do
             * neither. Reading the route table here would be the first line of the full
             * middleware's job, done twice, in a file whose entire contract is that it does
             * almost nothing.
             */
            tool: 'unknown',
            anonymous: false,
            language: identity.language ?? null,
        };
    } catch {
        /**
         * ⚠ **Swallowed on purpose, and not even logged.** Reaching here means the body was
         * not a bot envelope — which is the ordinary case for most traffic — so a log line
         * would be noise at the volume of every request. The consequence of arriving here is
         * that `req.bot` is undefined and the response is shaped exactly as it is today.
         */
    }

    next();
}
