import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { commandRouterService } from '../../bot-commands/services/command-router.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { BotCommandDispatchSchema } from '../validators/bot.validators';

/**
 * `POST /command` — the typed slash-command door.
 *
 * ── ONE ROUTE FOR EVERY COMMAND, AND THE VOCABULARY IS SERVER-SIDE ──────────
 * The automation layer forwards the raw text of any message beginning with `/` and does
 * nothing else: it holds no command list, no alias table, no argument grammar and no
 * suggestion rule. That is the point — the alias table is a five-language table, and n8n is
 * the one layer with no copy table (`bot-surface.md` § 14.6 makes exactly this argument
 * about parsing, and the boundary has now moved server-side five times).
 *
 * ⚠ **NOT `anonymous`, and the first draft had it the other way.** It was flagged so `/help`
 * could answer an unresolved sender; `test:bot-surface` refused that, correctly — the
 * exemption is for rows answering questions *about* the sender, and this one **acts for
 * them**. In practice the case barely exists: `/identity/sync` runs on every message and
 * auto-registers, and where resolution genuinely fails the identity refusal already carries
 * `customerMessage` and renders a `request_contact` keyboard on an unbound Telegram chat —
 * a better first turn than a command list to somebody the platform cannot act for.
 *
 * ⚠ **`mutating: true`, and the cost is stated rather than solved.** One route carries both
 * `/orders` (a read) and `/cancel` (a write), and `mutating` is a property of the ROUTE, so
 * a `readonly` maintenance window refuses the read commands too. Splitting the route by verb
 * is not available: only the parser knows which verb a message is, and the parser runs
 * inside the handler — behind the guard that would have to make the decision. Closing it
 * properly means per-command maintenance classification, which is a follow-up.
 *
 * The `Idempotency-Key` that comes with `mutating` is real value, not overhead: a chat
 * client retrying one message must not run `/cancel` twice.
 */
export class BotCommandController {
    static dispatch = asyncHandler(async (req: Request, res: Response) => {
        const input = BotCommandDispatchSchema.parse(req.body ?? {});

        /**
         * ⚠ **The identity comes from the RESOLVED caller, the cosmetics from the envelope,
         * and the split is the rule rather than convenience.** `botCallerOf` is the only way
         * a handler on this surface may learn who it is acting for — reading `req.bot.caller`
         * directly would skip the throw that turns an unmounted guard into a loud 500 instead
         * of a silent read of somebody else's data, and `test:bot-surface` scans for exactly
         * that.
         *
         * `displayName` and `handle` are the other half and are deliberately taken from the
         * envelope: they are caller-supplied decoration for a connection row, they are trusted
         * for nothing, and the resolved account carries no equivalent.
         */
        const caller = botCallerOf(req);
        const { displayName, handle } = req.bot!.envelope;

        const outcome = await commandRouterService.route({
            text: input.text,
            sender: {
                channel: caller.channel,
                externalId: caller.externalIdentity,
                displayName: displayName ?? null,
                handle: handle ?? null,
            },
            language: botResponseLanguageOf(req),
        });

        if (outcome.kind === 'to_model') {
            /**
             * Nothing to say, deliberately — and `handled: false` is what the automation
             * layer branches on to pass the turn to the model. Setting no reply is the same
             * signal a finished onboarding checklist gives: the turn belongs to whoever
             * answers what the customer actually asked.
             */
            setBotReply(req, null);
            sendSuccess(res, {
                handled: false,
                command: outcome.command,
                reason: outcome.reason,
            });
            return;
        }

        setBotReply(req, outcome.intent);
        sendSuccess(res, { handled: true, ...outcome.data });
    });

}
