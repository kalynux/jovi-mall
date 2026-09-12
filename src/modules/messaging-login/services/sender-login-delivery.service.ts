import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';
import { getRedisClient, LOGIN_CODE_DB } from '../../../infra/redis/redis.factory';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { digestForKey } from '../domain/login-token';
import { buildLoginReply, buildMagicLinkUrl } from '../dto/messaging-login.dto';
import { ResolvedLoginAccount } from './identity-resolver.service';
import { MessagingLoginService, messagingLoginService } from './messaging-login.service';

/**
 * A sign-in credential, sent to the chat the sender is already messaging from.
 *
 * ── THE FOURTH ENTRANCE, AND WHY IT SENDS RATHER THAN RETURNS ────────────────
 * `/login` (the slash command), the Telegram contact-share and the administrator dialog
 * are the other three, and all of them share `MessagingLoginService.mint` — the same
 * ten-minute record, the same two credentials, the same single-use semantics. This one
 * exists for a customer who asks in WORDS ("can I get the login code?"), which the model
 * answers by calling `auth_send_login_link` on the MCP surface.
 *
 * ⚠ **The two bot commands RETURN their message and this one SENDS it, and that reversal
 * is the entire point of the route.** `/connect` and `/login` return a `message` the
 * automation layer relays, on the argument that one outbound path is better than two. That
 * argument holds when the relay is a deterministic node copying a string. It inverts when
 * the caller is a language model:
 *
 *   - **The catalogue forbids it.** `auth_send_login_link` is `result_kind: verbatim_relay`
 *     with `never_relay: ["message"]` — the credential is never summarised, never stored
 *     and **never shown to the model**. A tool response is neither: it lands in the model's
 *     context and in the `Chat Memory` Redis store, where a live session credential has no
 *     business being.
 *   - **A model would paraphrase it.** An eight-character code copied by something that
 *     rewrites for tone is a code that arrives wrong, and the customer cannot tell why.
 *
 * So the credential travels from here to the person without passing through the model, and
 * the tool answers only whether it went. `AdminCredentialDeliveryService` took the same
 * shape for the same reason one layer up: its response carries no token, no link and no
 * unmasked destination either.
 *
 * ── THERE IS NO DESTINATION TO RESOLVE, AND THAT IS THE SECURITY PROPERTY ────
 * The administrator path reads a destination off the party's record, because an operator
 * who could type one could mail themselves a working credential for somebody else's
 * account. Here the destination is not a field at all: it is the chat the request arrived
 * from, already resolved by `requireBotIdentity` from a sealed token the automation layer
 * cannot mint. There is no argument on this route that names a person, so there is nothing
 * to abuse — the same rule `/connect` enforces by reading the sender from the CONTEXT.
 */

/**
 * How many sign-in credentials one messaging identity may be sent per hour.
 *
 * Lower than the administrator path's three-per-party, and the reason is the caller: that
 * one is an operator watching a dialog, this one is a language model that can be talked
 * into repeating itself. The limit is not a defence against the customer — it is their own
 * account — but against a loop, and against a chat that becomes unusable because every
 * turn mints a fresh credential and revokes the last one.
 *
 * ⚠ **Minting REVOKES the previous pair** (`issue()` revokes the identity's previous code
 * so the guessable set never accumulates). So an unbounded caller does not merely spam:
 * it invalidates the code the customer is in the middle of typing.
 */
const PER_IDENTITY_LIMIT = 5;
const PER_IDENTITY_WINDOW_SECONDS = 60 * 60;

/**
 * Hashed for the reason the login store hashes its own: `/system/cache/keys` lists key
 * NAMES to any dev-tools caller, so a raw `telegram:1804835114` there is a listing of who
 * has been asking to sign in.
 */
const identityKey = (channel: string, externalIdentity: string): string =>
    `bot_login_link:identity:${digestForKey(`${channel}:${externalIdentity}`)}`;

/** What the tool tells the model. Deliberately not a credential. */
export interface SenderLoginDeliveryResult {
    /** Whether the message reached the channel. */
    sent: boolean;
    /** How long the credential the customer just received is good for. */
    expiresInSeconds: number;
    expiresAt: string;
}

export class SenderLoginDeliveryService {
    constructor(
        private readonly logins: MessagingLoginService = messagingLoginService,
        private readonly telegram: TelegramNotificationService = new TelegramNotificationService(),
    ) { }

    /**
     * Mint a sign-in pair for this sender and put it in their chat.
     *
     * The caller is the RESOLVED bot identity, which `BotIdentityService.resolve` produced
     * by running `resolveForLogin` — the same three-step ladder the slash command uses. So
     * the gate has already run by the time this is reached, and re-running it here would
     * ask the same question twice and risk two answers.
     */
    async send(caller: ResolvedLoginAccount): Promise<SenderLoginDeliveryResult> {
        await this.assertWithinLimit(caller);

        const issued = await this.logins.mint(caller);

        /**
         * The identity, never the credentials — the line `/login` already writes. A token
         * or a code in a log is a live session, and this path is reached by a model, which
         * makes the log the only place a human will look afterwards.
         */
        logger().info(
            { channel: caller.channel, tool: 'auth_send_login_link' },
            'issued a sign-in session for a bot-surface request',
        );

        const body = buildLoginReply(
            issued.code,
            buildMagicLinkUrl(issued.token),
            issued.ttlSeconds,
        );

        await this.deliver(caller, body);

        return {
            sent: true,
            expiresInSeconds: issued.ttlSeconds,
            expiresAt: issued.expiresAt.toISOString(),
        };
    }

    /**
     * Counted on the ATTEMPT rather than on success, matching the administrator path: a
     * delivery that fails downstream may well have gone out, and pretending otherwise
     * hands a retry loop a free pass.
     */
    private async assertWithinLimit(caller: ResolvedLoginAccount): Promise<void> {
        const redis = await getRedisClient(LOGIN_CODE_DB);
        const key = identityKey(caller.channel, caller.externalIdentity);

        /**
         * `INCR` then `EXPIRE`, in that order — setting the TTL first leaves a window in
         * which a crash produces a counter that never expires, i.e. a permanent block on
         * one customer. Both commands predate Redis 2.6, which the dev instance requires.
         *
         * The twin of this counter is `bump()` in `admin-credential-delivery.service.ts`.
         * Deliberately not shared: that file guards a harassment surface and is not worth
         * editing for a dedupe, and the two limits answer to different callers.
         */
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, PER_IDENTITY_WINDOW_SECONDS);
        if (count <= PER_IDENTITY_LIMIT) return;

        const ttl = await redis.ttl(key);
        throw createAppError(
            ERROR_CODES.USER_CREDENTIAL_LINK_THROTTLED,
            429,
            'A sign-in link was sent very recently — check the earlier message before asking for another',
            { retryAfterSeconds: ttl > 0 ? ttl : PER_IDENTITY_WINDOW_SECONDS },
        );
    }

    /**
     * ⚠ **A delivery failure is RAISED, not swallowed**, and on this route that matters
     * more than on the administrator one. The model's next sentence is "I've sent it" — so
     * a silent failure produces a customer waiting for a message that does not exist, and
     * a chat transcript that says it was sent. The refusal reaches the model as tool
     * content it can act on.
     */
    private async deliver(caller: ResolvedLoginAccount, body: string): Promise<void> {
        try {
            if (caller.channel === 'whatsapp') {
                /**
                 * Lazily imported for the reason `PasswordResetService` and the
                 * administrator path both state: the WhatsApp module drags in the
                 * messaging stack and its configuration, and this module must stay
                 * loadable without it.
                 *
                 * ⚠ The 24-hour service window is open by construction here — the customer
                 * messaged the bot in this very turn, which is what opened it — so this
                 * never needs the template branch `bot-messaging.controller.ts` documents.
                 */
                const { WhatsAppServiceMessenger } = await import(
                    '../../whatsapp/services/whatsapp-service-messenger'
                );
                await new WhatsAppServiceMessenger().sendText({
                    to: caller.externalIdentity,
                    body,
                    /**
                     * Off, and not for tidiness: WhatsApp FETCHES a URL to build its
                     * preview card, and the magic link's page is designed around never
                     * being fetched by anything but a human.
                     */
                    previewUrl: false,
                });
                return;
            }

            const result = await this.telegram.send({
                chatId: caller.externalIdentity,
                message: body,
            });
            if (!result.success) {
                throw createAppError(
                    ERROR_CODES.MESSAGING_DELIVERY_FAILED,
                    502,
                    result.error ?? 'Telegram delivery failed',
                );
            }
        } catch (error) {
            if (isAppError(error)) throw error;
            logger().warn(
                { err: error, channel: caller.channel },
                'bot-surface sign-in link delivery failed',
            );
            throw createAppError(
                ERROR_CODES.MESSAGING_DELIVERY_FAILED,
                502,
                'The sign-in link could not be delivered to this chat',
                { channel: caller.channel },
            );
        }
    }
}

function isAppError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && 'statusCode' in error;
}

export const senderLoginDeliveryService = new SenderLoginDeliveryService();
