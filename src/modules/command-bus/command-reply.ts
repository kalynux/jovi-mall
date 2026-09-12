import { MessagingChannel } from '../channel-connections';
import { botChrome } from '../bot-surface/domain/bot-chrome-copy';
import { BotChannelReply, BotReplyIntent, renderBotReply } from '../bot-surface/domain/channel-reply';

/**
 * Turn a command result into a channel-ready request body.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS HERE RATHER THAN IN A COMMAND ─────────────
 * The four bot commands (`connect`, `login`, `login_contact`, `reset_password`) answer with
 * a bare `message` string and, on two of them, a `requestContact` flag. That contract
 * predates the bot surface's `reply` convention, and until now the automation layer was
 * expected to make the difference up: relay the string, and *"render a `request_contact`
 * keyboard on `requestContact: true`"*.
 *
 * ⚠ **That instruction was never carried out, and it is why `/login` did nothing for
 * months.** The n8n side was rebuilt on 2026-09-06 with no command handling at all, so
 * `/login` fell through to the model, which apologised and invented an OTP screen. Rebuilding
 * the branch means deciding where the keyboard shape lives — and the owner rule is that the
 * bot RELAYS and never RENDERS (`bot-surface.md` § 14): n8n holds no copy table, no button
 * labels and no `reply_markup` shapes. Every other turn on this platform already arrives as
 * a ready body.
 *
 * So the commands join that convention here rather than each learning to render, which
 * keeps one renderer (`channel-reply.ts`) and one copy table (`bot-chrome-copy.ts`) for the
 * whole bot surface — including the `request_contact` keyboard, which the onboarding phone
 * step already draws with this exact button.
 *
 * ── WHY THE CONTROLLERS CALL IT AND NOT THE COMMANDS ────────────────────────
 * A command knows its reply; it does not know the recipient. `chat_id` and `reply_to` are
 * webhook fields, read from the CONTEXT rather than the payload — the rule that keeps a
 * caller from naming somebody else's chat. Rendering at the controller means the address
 * comes from the same place the identity does, and means a fifth command added later gets a
 * `reply` for free instead of being the one that forgot.
 */

/** The two fields every bot command result carries. Anything else is passed through. */
export interface RenderableCommandResult {
    message?: unknown;
    /** `/login` and `/reset-password` set it on an unbound Telegram chat. */
    requestContact?: unknown;
}

/**
 * @param result   whatever the command handler returned
 * @param channel  from the webhook route, never from the payload
 * @param recipient `chat_id` (Telegram) or `reply_to` (WhatsApp), from the context
 * @param language the sender's language where one is known — see the note below
 */
export function buildCommandChannelReply(
    result: RenderableCommandResult,
    channel: MessagingChannel,
    recipient: string,
    language: string | null = null,
): BotChannelReply | null {
    const intent = commandReplyIntent(result, language);
    if (!intent || !recipient) return null;

    return renderBotReply(intent, channel, recipient);
}

/**
 * The same decision, stopping one step earlier — at the INTENT rather than a rendered body.
 *
 * ⚠ **The bot surface needs the INTENT, not the rendered reply**, because `attachBotReply`
 * renders there: it knows the channel and the recipient from `req.bot`, and it also handles
 * the multi-message case. A router that rendered its own body would have to know both, and
 * would bypass the interceptor that puts `reply` into the envelope *before* the idempotency
 * guard captures it — so a replayed 200 would come back with nothing to send.
 *
 * So the two entrances share this function and differ only in who renders: the webhook
 * controllers render here (they have no `req.bot`), the typed-command router does not.
 */
export function commandReplyIntent(
    result: RenderableCommandResult,
    language: string | null = null,
): BotReplyIntent | null {
    const text = typeof result?.message === 'string' ? result.message.trim() : '';
    if (!text) return null;

    /**
     * ⚠ **`requestContact` is Telegram-only in effect, and `channel-reply.ts` is what makes
     * that true rather than a branch here.** WhatsApp has no `request_contact` control at
     * all; its renderer degrades `contact_request` to the text alone, which is right — on
     * WhatsApp the sender's number IS the identity, so the prompt is unreachable there
     * anyway (`identity-resolver.service.ts` step 2 resolves before it can be raised).
     */
    if (result?.requestContact === true) {
        return {
            kind: 'contact_request',
            text,
            buttonLabel: botChrome('contactButton', language),
        };
    }

    return { kind: 'text', text };
}

/**
 * ⚠ **`language` is null on every command today, and that is honest rather than unfinished.**
 * The command surface is English-only outbound — `buildLoginReply`, `buildContactPrompt` and
 * `/connect`'s copy are all English literals — because at `/connect` and at an unresolved
 * `/login` there is no account to read `preferred_language` from. Passing null makes the
 * button match the message instead of putting a French button under English prose.
 *
 * The moment a command starts localising its `message`, this is the argument that carries it.
 */
