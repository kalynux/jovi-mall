import { z } from 'zod';
import { CommandHandler } from '../../command-bus/command-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { MessagingChannel, isMessagingChannel } from '../domain/channel';
import { connectionCodeStore } from '../services/connection-code.store';

export const command_name = 'connect';

/**
 * `/connect` — the bot half of the connection handshake, for BOTH channels.
 *
 * One command, one handler. Its two predecessors (`link` for WhatsApp, `link_telegram`
 * for Telegram) were two commands doing one job in two shapes, and the only thing that
 * genuinely differs between the channels is which field of the webhook context names
 * the sender. That difference is resolved in `resolveIdentity` below and nowhere else —
 * adding a third channel means adding a branch there and an entry in `domain/channel.ts`.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * **It creates no account link.** It cannot: nobody is authenticated here. A bot webhook
 * knows a phone number or a chat id and nothing whatsoever about a platform account, and
 * the whole point of the redesign is that it is never asked to guess. All this mints is a
 * temporary credential standing for the *messaging identity* — the binding happens later,
 * at `POST /api/me/connections`, where a real session says who is claiming it.
 *
 * So a leaked or intercepted code discloses a WhatsApp number at worst, and grants an
 * attacker the ability to attach *their own* messaging account to *their own* platform
 * account. It is never a step toward taking over somebody else's.
 */

/**
 * The payload the automation layer sends.
 *
 * Everything is optional except by channel, and the identity is read from the **context**
 * rather than from here where possible — see `resolveIdentity`. The profile fields are
 * cosmetic: they become `display_name` / `handle` on the connection so a settings screen
 * can say "Jane D." instead of a bare masked number.
 */
export const schema = z.object({
    /** WhatsApp profile name, or the Telegram first (+ last) name. */
    name: z.string().trim().max(120).optional(),
    /** Telegram `@username`. WhatsApp has no equivalent. */
    username: z.string().trim().max(120).optional(),
}).partial().default({});

interface ConnectContext {
    source?: string;
    /** WhatsApp: the WA-assigned sender id. Set by `WhatsappController.handleWebhook`. */
    wa_phone_id?: string;
    /** Telegram: the chat id. Set by `TelegramController.handleWebhook`. */
    chat_id?: string;
}

/**
 * Which messaging account sent this, from the context the webhook controller built.
 *
 * ⚠ **Read from the CONTEXT, never from the command payload.** The context is assembled by
 * the controller out of the webhook's own sender fields; the payload is free-form data the
 * caller supplies. They look interchangeable and are not: taking the identity from the
 * payload would let anyone who can reach the webhook mint a code for an arbitrary phone
 * number. That is the same trust mistake the deleted `link` command made — it read
 * `payload.wa_data.wa_phone_id` — and it is the one worth not repeating.
 *
 * (The webhook itself is only as trustworthy as `requireBotWebhookSecret` makes it. This
 * function keeps the payload out of the decision either way, so the two guards are
 * independent.)
 */
function resolveIdentity(context: ConnectContext): { channel: MessagingChannel; externalIdentity: string } {
    const source = context.source;

    if (!isMessagingChannel(source)) {
        throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED, 400, undefined, { source });
    }

    const externalIdentity = source === 'whatsapp'
        ? context.wa_phone_id
        : context.chat_id;

    if (!externalIdentity || !externalIdentity.trim()) {
        throw createAppError(ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED, 400, undefined, {
            channel: source,
        });
    }

    return { channel: source, externalIdentity: externalIdentity.trim() };
}

/** Telegram handles are conventionally written with the `@`; store one form. */
function normalizeHandle(username: string | undefined): string | null {
    if (!username) return null;
    const trimmed = username.trim().replace(/^@+/, '');
    return trimmed ? `@${trimmed}` : null;
}

/**
 * The reply the bot sends back.
 *
 * **English only, and that is a constraint rather than an oversight.** Every other piece of
 * outbound copy in this service is localised from a catalog keyed on the recipient's
 * `preferred_language` — but that lives on a role entity, and at this moment there is no
 * account to read it from. That is the entire premise of the flow. Localising would mean
 * guessing from a phone prefix, which is wrong often enough to be worse than not trying.
 *
 * Once connected, everything the platform sends this person IS localised.
 */
function replyText(channel: MessagingChannel, code: string, minutes: number): string {
    const channelName = channel === 'whatsapp' ? 'WhatsApp' : 'Telegram';
    return [
        `Your connection code is: ${code}`,
        '',
        `Enter this code on Jovi Mall to connect your ${channelName} account.`,
        `It expires in ${minutes} minutes and can only be used once.`,
        '',
        'Nothing has been connected yet — this code does nothing until you enter it.',
        'If you did not ask for it, ignore this message.',
    ].join('\n');
}

export interface ConnectCommandResult {
    success: true;
    channel: MessagingChannel;
    code: string;
    expiresInSeconds: number;
    /**
     * The verbatim text the automation layer must relay to the user.
     *
     * The bot bridge relays this; this service does NOT send the message itself, and the
     * asymmetry is deliberate. Sending it here would mean two outbound paths (Meta Cloud
     * API and the Telegram Bot API) with two failure modes, and a code minted whether or
     * not the person ever received it. Returning it keeps one path and one failure: if the
     * relay fails, nobody got a code and `/connect` can simply be sent again.
     */
    message: string;
}

export const handler: CommandHandler<z.infer<typeof schema>, ConnectCommandResult> = async (
    payload,
    context: ConnectContext
) => {
    const { channel, externalIdentity } = resolveIdentity(context);

    /**
     * Minting revokes whatever live code this identity already held — see
     * `ConnectionCodeStore.issue`. Sending `/connect` five times therefore leaves ONE
     * usable code, not five, which is what keeps the guessable population flat no matter
     * how often somebody taps the button.
     */
    const issued = await connectionCodeStore.issue({
        channel,
        externalIdentity,
        displayName: payload.name ?? null,
        handle: channel === 'telegram' ? normalizeHandle(payload.username) : null,
    });

    const minutes = Math.round(issued.ttlSeconds / 60);

    // The identity, never the code: a code in a log is a live credential, and this line
    // is written on every /connect.
    console.log(`[Connections] issued a connection code for ${channel}:${externalIdentity}`);

    return {
        success: true,
        channel,
        code: issued.code,
        expiresInSeconds: issued.ttlSeconds,
        message: replyText(channel, issued.code, minutes),
    };
};
