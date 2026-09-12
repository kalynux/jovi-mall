import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { senderLoginDeliveryService } from '../../messaging-login/services/sender-login-delivery.service';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { BotNoArgsSchema } from '../validators/bot.validators';

/**
 * Account access from a chat, for the customer who asks in words.
 *
 * ── WHY THIS ROUTE EXISTS WHEN `/login` ALREADY DOES ────────────────────────
 * `/login` is a slash command: `wi-mall-core` matches it deterministically, posts it to
 * `POST /api/webhooks/{channel}`, and the model never sees the turn. That is the right
 * shape for somebody who types the command, and it is the *only* shape until somebody says
 * *"can I get the login code?"* instead — which is a sentence, not a command, and reaches
 * the model like any other.
 *
 * So this is the same command with a second entrance, and the catalogue always specified it
 * (`auth_send_login_link`). What it did not specify correctly was the SURFACE.
 *
 * ── ⚠ THE CATALOGUE PUT THIS ON `webhook_command` AND IT COULD NOT LIVE THERE ──
 * `isModelFacing()` in `scripts/gen-mcp-workflow.ts` excludes the whole `webhook_command`
 * surface, and the exclusion is correct as written: *"`wi-mall-core` calls those with plain
 * `httpRequest` nodes before the agent runs; they are flow plumbing, not tools."* That is
 * true of `/connect`, of `login_contact`, and of `/login`-as-a-command.
 *
 * The tool was therefore specified and never emitted — for months the catalogue advertised
 * `auth_send_login_link` and the live MCP server served no such tool, which is why the model
 * answered *"I don't have a way to log you in"* and then invented an OTP screen that does
 * not exist.
 *
 * ⚠ **The fix was NOT to widen that exclusion.** Widening it would have handed the model a
 * node that returns the credential in its response body, and the catalogue's own
 * `never_relay: ["message"]` forbids exactly that. The row moved to `bot_internal` instead,
 * where it is an ordinary sealed-token tool like the other fifty — and the credential leaves
 * by a path the model is not on. See `sender-login-delivery.service.ts` for that half.
 *
 * ── WHAT THE MODEL LEARNS, AND WHAT IT MUST NOT ─────────────────────────────
 * `{ sent, expiresInSeconds, expiresAt }`. No token, no code, no link, no phone number.
 * The customer already has all four, in a message this route sent them directly, worded by
 * `buildLoginReply` — the same copy the slash command produces, byte for byte, because it
 * is the same function.
 *
 * ── ONLY `/login` LIVES HERE, AND `/reset-password` DELIBERATELY DOES NOT ────
 * The catalogue also specifies `auth_send_password_reset_link`, and it is **not** mounted.
 * A sign-in credential grants one customer session; a reset token stamps
 * `password_changed_at`, which evicts every live session on the account — and unlike
 * `/login` it serves every role, so the account it acts on may be a vendor's. That is a
 * bigger thing to hand to a sentence classifier than a ten-minute customer session, and the
 * slash command remains its entrance. Mounting it later is a row in `BOT_ROUTES`, a handler
 * here and a decision recorded; it is not an oversight.
 */
export class BotAuthController {
    /**
     * `POST /auth/login-link` — send this sender a sign-in link and code.
     *
     * ⚠ **No arguments, and the empty schema is load-bearing rather than lazy.** The
     * catalogue's original row carried cosmetic `name` and `username` fields, which the
     * slash command uses to decorate a connection row it may be creating. Nothing is
     * created here: `requireBotIdentity` has already resolved this sender to an existing
     * account, so the fields would decorate nothing and would be the only strings on this
     * route a caller could choose. `BotNoArgsSchema` is `.strict()`, so sending one is a
     * 400 rather than a silent ignore.
     */
    static sendLoginLink = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const result = await senderLoginDeliveryService.send(caller);

        /**
         * ⚠ **Explicitly NO channel reply, and this is the one route on the surface where
         * that is true.** Every other handler leaves a `reply` for the automation layer to
         * send. Here the message is already in the customer's chat — this route sent it —
         * so a second body would deliver the credential twice, and `attachBotReply`'s
         * default would compose that second body from a response that has nothing to say.
         *
         * The model reads the fields below and words its own one-line confirmation, which
         * is exactly the division `open_negotiation` already uses for the bargaining
         * hand-off: the tool acts, the model acknowledges.
         */
        setBotReply(req, null);

        sendSuccess(res, result, {
            // Read by the model, so it is written for one: it must not imply the model has
            // the code, and it must not read as something to repeat to the customer.
            message: 'The sign-in link and code have been sent to this chat.',
        });
    });
}
