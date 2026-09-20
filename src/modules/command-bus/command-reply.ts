import { MessagingChannel } from '../channel-connections';
import { BotChromeKey, botChrome } from '../bot-surface/domain/bot-chrome-copy';
import {
    BotChannelReply,
    BotReplyIntent,
    BotReplyOption,
    renderBotReply,
} from '../bot-surface/domain/channel-reply';
import { inAppScreenUrl } from '../bot-surface/domain/inapp-url';
import { botStorefrontLink } from '../bot-surface/domain/bot-list-window';
import type { InAppSurfaceKind } from '../bot-surface/services/inapp-surface.store';

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

/**
 * An in-app screen a reply should open.
 *
 * The same four inputs `respondWithScreen` takes on the bot surface. The command has already
 * minted `handle`; nothing here mints, reads or checks a session.
 */
export interface CommandScreen {
    kind: InAppSurfaceKind;
    /** An `ia_…` handle the command minted for THIS conversation. */
    handle: string;
    /** The button's label, from the chat chrome table. */
    labelKey: BotChromeKey;
    /** A storefront path to fall back to when no screen origin is configured, or null. */
    fallbackPath: string | null;
}

/** The fields a bot command result may carry. Anything else is passed through. */
export interface RenderableCommandResult {
    message?: unknown;
    /** `/login` and `/reset-password` set it on an unbound Telegram chat. */
    requestContact?: unknown;
    /**
     * Open an in-app screen under the message.
     *
     * ── WHY A COMMAND NEEDS THIS AT ALL ─────────────────────────────────────
     * Until this field existed a command could answer with words or a contact keyboard and
     * nothing else, so a customer who chose a product in the WhatsApp listing form was told
     * "got that" and handed nothing to tap. The chat's own product door (`POST /inapp/products`)
     * could open the detail screen; the command path couldn't.
     */
    screen?: CommandScreen | null;
    /**
     * Buttons beside the message.
     *
     * ⚠ **For a command whose answer has known next steps** — today, a WhatsApp form that added
     * to the basket, which must offer the same three controls the chat's own "added to cart"
     * offers. The command supplies the list; nothing here composes one, and no channel cap is
     * applied here either: `channel-reply.ts` drops a fourth button before it reaches Meta, in
     * the one place that knows each channel's limits.
     */
    actions?: readonly BotReplyOption[];
    /**
     * The customer's language, when the command could establish it and the caller couldn't.
     *
     * The webhook controllers render with `language = null` because at `/connect` or an
     * unresolved `/login` there is no account to read one from (see the note at the bottom of
     * this file). A command that resolved an in-app session does know it, from the session, and
     * a French customer shouldn't get an English button because the controller didn't. A
     * language the CALLER supplies still wins: the bot surface's router resolves it from the
     * account.
     */
    language?: string | null;
}

/**
 * Compose the reply that opens an in-app screen: the screen button when a screen origin is
 * configured, the storefront link when one isn't, and nothing when neither exists.
 *
 * ── ⚠ ONE COMPOSITION FOR BOTH DOORS ────────────────────────────────────────
 * `respondWithScreen` on the bot surface makes exactly this decision for the chat's doors, and
 * the command path makes it here. They must not become two copies. When the WhatsApp form is
 * attached to the `inapp` intent, it has to be attached in ONE place, or the chat door would
 * open a form and the command path would open a browser for the same screen. This function is
 * that place, and `respondWithScreen` is meant to delegate to it.
 *
 * Pure: every input is a value. The URL helpers read configuration and nothing else.
 */
export function screenReplyIntent(input: {
    kind: InAppSurfaceKind;
    handle: string;
    language: string | null;
    labelKey: BotChromeKey;
    fallbackPath: string | null;
    /** The sentence above the button. Defaults to the chat's browse prompt, as the doors do. */
    text?: string | null;
}): BotReplyIntent | null {
    const label = botChrome(input.labelKey, input.language);
    const text = input.text?.trim() || botChrome('browseProductsPrompt', input.language);

    const screenUrl = inAppScreenUrl(input.kind, input.handle, input.language);
    if (screenUrl) return { kind: 'inapp', text, label, url: screenUrl };

    const fallbackUrl = input.fallbackPath
        ? botStorefrontLink(input.fallbackPath, input.language)
        : null;
    return fallbackUrl ? { kind: 'link', text, label, url: fallbackUrl } : null;
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
    const lang = language ?? (typeof result?.language === 'string' ? result.language : null);

    /**
     * ⚠ **A screen outranks a plain message, and it may arrive without one.** The screen carries
     * its own default sentence, the same one the chat's doors use. If neither a screen origin
     * nor a fallback exists, this falls through to the message alone rather than sending
     * nothing, so a customer who finished a form still gets the words.
     */
    if (result?.screen) {
        const screenIntent = screenReplyIntent({ ...result.screen, language: lang, text });
        if (screenIntent) return screenIntent;
    }

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
            buttonLabel: botChrome('contactButton', lang),
        };
    }

    /**
     * ⚠ **Buttons ride the `text` intent, not a `choice`.** `choice` means *pick one of these and
     * nothing else*; this is *here is what happened, and here are the three things you probably
     * want next* — the customer may still type instead, which on this surface they often do.
     * The same distinction the chat's own "added to cart" turn draws.
     */
    const actions = Array.isArray(result?.actions) && result.actions.length > 0
        ? (result.actions as readonly BotReplyOption[])
        : null;

    return actions ? { kind: 'text', text, actions } : { kind: 'text', text };
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
