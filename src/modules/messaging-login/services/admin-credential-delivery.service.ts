import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';
import { getRedisClient, LOGIN_CODE_DB } from '../../../infra/redis/redis.factory';
import { connectionService } from '../../channel-connections';
import { CustomerRepository } from '../../customers/customer.repository';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { IUser } from '../../users/user.model';
import { UserRepository } from '../../users/user.repository';
import {
    PasswordResetService,
    RESET_TOKEN_TTL_MINUTES,
    passwordResetService,
} from '../../auth/services/password-reset.service';
import { digestForKey } from '../domain/login-token';
import { buildMagicLinkUrl } from '../dto/messaging-login.dto';
import { LOGIN_SESSION_TTL_SECONDS } from './login-session.store';
import { MessagingLoginService, messagingLoginService } from './messaging-login.service';

/**
 * Administrator-initiated account recovery.
 *
 * ── What this is, and what it deliberately is not ────────────────────────────
 * An operator on the admin dashboard asks the platform to send a party a way back into
 * their own account. It is NOT a way to obtain one: the response carries no token, no
 * link and no unmasked destination, and the destination is read from the party's own
 * record rather than accepted from the caller. An operator who could type the address
 * could mail a working credential for somebody else's account to themselves, which is
 * the whole attack this shape closes.
 *
 * ── A third ENTRANCE, never a third mechanism ────────────────────────────────
 * Both credentials come out of the machinery that already exists:
 *
 *   reset  → `PasswordResetService.issueResetLinkFor` — the same 32-byte token, the same
 *            30 minutes, the same `password_reset:` key space, redeemed at the same
 *            `POST /auth/reset-password`, and therefore carrying the same
 *            `password_changed_at` stamp that evicts every live session.
 *   login  → `MessagingLoginService.mintForAdministrator` — the same ten-minute session
 *            record, the same single-use semantics, the same `customer` literal.
 *
 * A second store is how two entrances drift on single-use or on expiry. `test:messaging-login`
 * already asserts there is exactly one `randomBytes(32)` in the reset service; nothing
 * here adds a second.
 *
 * ── Why the login link is customers only ─────────────────────────────────────
 * `MessagingLoginService` scopes every session it mints to `customer`, as a literal,
 * because a vendor, agency or agent reaches money and other people's data and signs in
 * with a password. That is unchanged here — an administrator does not get to mint a
 * privileged session for somebody else. The operator's own request drew the same line:
 * a login link for customers, a reset link for everybody else. Customers are largely
 * passwordless (see `RegisterSchema`), so for most of them the reset link is the odd fit
 * and the login link is the useful one; for every other role it is the reverse.
 *
 * ── On verified destinations ─────────────────────────────────────────────────
 * There is no verification gate, and that is a finding rather than an omission: `IUser`
 * carries no `email_verified`. Verification flags live on the ROLE entities
 * (`DeliveryAgent.email_verified` and friends), a user may hold several roles, and
 * `login_email` is the login identifier itself — the address `POST /auth/forgot-password`
 * already mails a live reset token to, anonymously, with no check. Gating the
 * administrator path more tightly than the path an attacker can drive would protect
 * nothing.
 */

export type CredentialKind = 'password_reset' | 'login';
export type CredentialChannel = 'email' | 'whatsapp' | 'telegram';

export interface CredentialDeliveryResult {
    kind: CredentialKind;
    channel: CredentialChannel;
    /** `+2376••••4417`, `j••••@example.com`, `@handle`. Never the whole address. */
    destinationMasked: string;
    expiresAt: string;
    sentAt: string;
}

/**
 * How many links one party may be sent, and how many one administrator may send.
 *
 * Both limits exist and neither is the other's substitute: the per-party one is a
 * harassment and SMS-bill bound (the party did not ask for any of these), the
 * per-administrator one bounds a compromised or careless operator account. An unlimited
 * endpoint here is a way to make somebody's phone unusable.
 */
const PER_PARTY_LIMIT = 3;
const PER_PARTY_WINDOW_SECONDS = 60 * 60;
const PER_ADMIN_LIMIT = 30;
const PER_ADMIN_WINDOW_SECONDS = 60 * 60;

/**
 * Key names are hashed for the same reason the login store hashes its own:
 * `/system/cache/keys` lists key NAMES to any dev-tools caller, so a raw user id there
 * is a listing of who has been asked about.
 */
const partyKey = (userId: string): string => `admin_credential:party:${digestForKey(userId)}`;
const adminKey = (adminId: string): string => `admin_credential:admin:${digestForKey(adminId)}`;

export class AdminCredentialDeliveryService {
    constructor(
        private readonly users: UserRepository = new UserRepository(),
        private readonly customers: CustomerRepository = new CustomerRepository(),
        private readonly resets: PasswordResetService = passwordResetService,
        private readonly logins: MessagingLoginService = messagingLoginService,
        private readonly mail: MailService = new MailService(),
        private readonly telegram: TelegramNotificationService = new TelegramNotificationService(),
    ) { }

    async send(
        kind: CredentialKind,
        userId: string,
        channel: CredentialChannel,
        actorId: string | null,
    ): Promise<CredentialDeliveryResult> {
        const user = await this.users.findById(userId);
        if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404, 'No such user');

        /**
         * Refused loudly, unlike the self-service path's silence. That path must answer
         * identically for a real and an imaginary account because its caller is anonymous
         * and chooses the identifier; this caller is an authenticated administrator
         * looking at the account, so there is no oracle to close and a silent no-op would
         * only leave them wondering whether it sent.
         */
        if (user.status !== 'active') {
            throw createAppError(
                ERROR_CODES.AUTH_ACCOUNT_SUSPENDED,
                409,
                'This account is suspended — reinstate it before sending a credential',
            );
        }

        const destination = await this.resolveDestination(user, channel);

        await this.assertWithinLimits(userId, actorId);

        const issued =
            kind === 'password_reset'
                ? await this.issueReset(user)
                : await this.issueLogin(user);

        await this.deliver(kind, channel, destination, issued);

        return {
            kind,
            channel,
            destinationMasked: destination.masked,
            expiresAt: issued.expiresAt.toISOString(),
            sentAt: new Date().toISOString(),
        };
    }

    /**
     * Where this channel reaches this party — or a refusal naming the channel.
     *
     * Telegram is the one that needs a lookup rather than a column: a `chat_id` bears no
     * relation to a phone number and the platform stores none on any party. It exists
     * only once somebody has run `/connect` in the chat, which is exactly the right
     * gate — an unconnected party has no Telegram address, and inventing one is not
     * possible rather than merely refused.
     */
    private async resolveDestination(
        user: IUser,
        channel: CredentialChannel,
    ): Promise<{ address: string; masked: string }> {
        if (channel === 'email') {
            if (!user.login_email) throw channelUnavailable('email');
            return { address: user.login_email, masked: maskEmail(user.login_email) };
        }

        if (channel === 'whatsapp') {
            if (!user.login_phone) throw channelUnavailable('whatsapp');
            return { address: user.login_phone, masked: maskPhone(user.login_phone) };
        }

        const connection = await connectionService.getConnection(String(user._id), 'telegram');
        if (!connection) throw channelUnavailable('telegram');
        return {
            address: connection.external_id,
            // The handle where there is one; otherwise a shape that discloses nothing but
            // confirms a chat exists. `external_id` is a chat id and never leaves here.
            masked: connection.handle ? `@${connection.handle.replace(/^@/, '')}` : 'Telegram chat',
        };
    }

    /**
     * Two counters, checked before anything is minted.
     *
     * Incremented on the ATTEMPT rather than on success, so a caller cannot probe which
     * channels a party has by burning failures for free — and so a delivery that fails
     * downstream still costs the operator their allowance, which is the honest accounting
     * for a message that may well have gone out.
     */
    private async assertWithinLimits(userId: string, actorId: string | null): Promise<void> {
        const redis = await getRedisClient(LOGIN_CODE_DB);

        const partyRetry = await bump(redis, partyKey(userId), PER_PARTY_LIMIT, PER_PARTY_WINDOW_SECONDS);
        if (partyRetry !== null) throw throttled(partyRetry, 'party');

        if (actorId) {
            const adminRetry = await bump(redis, adminKey(actorId), PER_ADMIN_LIMIT, PER_ADMIN_WINDOW_SECONDS);
            if (adminRetry !== null) throw throttled(adminRetry, 'administrator');
        }
    }

    private async issueReset(user: IUser): Promise<IssuedCredential> {
        const link = await this.resets.issueResetLinkFor(user);
        return {
            link,
            code: null,
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
            minutes: RESET_TOKEN_TTL_MINUTES,
        };
    }

    /**
     * A customer sign-in link, and the refusal that guards it.
     *
     * The role check is `roles` on the user, and the profile check is the `customers` row
     * the session will be scoped to — both, because a `customer` role with no profile
     * would mint a session pointing at nothing, and `MessagingLoginService` re-reads and
     * re-judges the account at redemption anyway.
     */
    private async issueLogin(user: IUser): Promise<IssuedCredential> {
        if (!user.roles.includes('customer')) {
            throw createAppError(
                ERROR_CODES.USER_LOGIN_LINK_ROLE_UNSUPPORTED,
                409,
                'A sign-in link is only available for customers — send a password-reset link instead',
                { roles: user.roles },
            );
        }

        const customer = await this.customers.findByUserId(String(user._id));
        if (!customer) {
            throw createAppError(
                ERROR_CODES.USER_LOGIN_LINK_ROLE_UNSUPPORTED,
                409,
                'This account holds the customer role but has no customer profile to sign in to',
            );
        }

        const issued = await this.logins.mintForAdministrator({
            userId: String(user._id),
            customerId: String(customer._id),
        });

        return {
            link: buildMagicLinkUrl(issued.token),
            code: issued.code,
            expiresAt: issued.expiresAt,
            minutes: Math.round(LOGIN_SESSION_TTL_SECONDS / 60),
        };
    }

    /**
     * Put the credential in front of the person.
     *
     * ⚠ **A delivery failure is raised, not swallowed.** `PasswordResetService.deliver`
     * logs and continues, because its caller must answer identically whether or not the
     * account exists. Here the caller is an administrator watching a dialog: telling them
     * "sent" when nothing was sent makes them close the ticket and the party stays locked
     * out. Fail loudly and let them try another channel.
     */
    private async deliver(
        kind: CredentialKind,
        channel: CredentialChannel,
        destination: { address: string },
        issued: IssuedCredential,
    ): Promise<void> {
        const body = composeMessage(kind, issued);

        try {
            if (channel === 'email') {
                await this.mail.send({
                    to: destination.address,
                    type: 'AUTH',
                    subject: kind === 'password_reset' ? 'Reset your password' : 'Sign in to Jovi Mall',
                    template: 'reset-password',
                    variables: {
                        link: issued.link ?? '',
                        minutes: issued.minutes,
                        year: new Date().getFullYear(),
                    },
                });
                return;
            }

            if (channel === 'whatsapp') {
                // Imported lazily for the reason `PasswordResetService` states: the
                // WhatsApp module drags in the messaging stack and its config, and this
                // module must stay loadable without it.
                const { WhatsAppServiceMessenger } = await import(
                    '../../whatsapp/services/whatsapp-service-messenger'
                );
                await new WhatsAppServiceMessenger().sendText({
                    to: destination.address,
                    body,
                    // Off for a sign-in link: WhatsApp FETCHES urls to build a preview
                    // card, and the magic link's page is designed around never being
                    // fetched by anything but a human. Off for the reset too, for tidiness.
                    previewUrl: false,
                });
                return;
            }

            const result = await this.telegram.send({ chatId: destination.address, message: body });
            if (!result.success) {
                throw createAppError(
                    ERROR_CODES.MESSAGING_DELIVERY_FAILED,
                    502,
                    result.error ?? 'Telegram delivery failed',
                );
            }
        } catch (error) {
            if (isAppError(error)) throw error;
            logger().warn({ err: error, channel, kind }, 'admin-initiated credential delivery failed');
            throw createAppError(
                ERROR_CODES.MESSAGING_DELIVERY_FAILED,
                502,
                'The message could not be delivered on that channel',
                { channel },
            );
        }
    }
}

interface IssuedCredential {
    link: string | null;
    code: string | null;
    expiresAt: Date;
    minutes: number;
}

/**
 * The message body, for the two channels that take plain text.
 *
 * Both name the sender as the platform rather than as an operator: the party did not ask
 * for this, and "somebody at Jovi Mall sent you a link" is the fact. Both also say what
 * to do if it was not expected, because an unsolicited credential in a chat is exactly
 * the shape of a phishing message and the copy has to distinguish itself from one.
 */
function composeMessage(kind: CredentialKind, issued: IssuedCredential): string {
    if (kind === 'password_reset') {
        return [
            `Jovi Mall support has sent you a link to reset your password:`,
            issued.link ?? '(link unavailable — contact support)',
            '',
            `It expires in ${issued.minutes} minutes and can be used once.`,
            `If you did not expect this, ignore this message — your password has not changed.`,
        ].join('\n');
    }

    const lines = [`Jovi Mall support has sent you a way to sign in.`];
    if (issued.link) lines.push('', 'Tap to sign in on this device:', issued.link);
    if (issued.code) lines.push('', `Or enter this code: ${issued.code}`);
    lines.push(
        '',
        `${issued.link && issued.code ? 'Both expire' : 'It expires'} in ${issued.minutes} minutes and can be used once.`,
        `If you did not expect this, ignore this message — nobody can sign in without it.`,
    );
    return lines.join('\n');
}

/**
 * Increment a fixed-window counter and report the seconds to wait, or `null` when the
 * caller is inside the limit.
 *
 * `INCR` then `EXPIRE` on first write — the ordering matters: setting the TTL first would
 * leave a window in which a crash produces a counter that never expires, i.e. a permanent
 * block on one party. Both commands predate Redis 2.6, which the dev instance requires.
 */
async function bump(
    redis: Awaited<ReturnType<typeof getRedisClient>>,
    key: string,
    limit: number,
    windowSeconds: number,
): Promise<number | null> {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    if (count <= limit) return null;

    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : windowSeconds;
}

function throttled(retryAfterSeconds: number, scope: 'party' | 'administrator') {
    return createAppError(
        ERROR_CODES.USER_CREDENTIAL_LINK_THROTTLED,
        429,
        scope === 'party'
            ? 'This person has been sent too many links recently'
            : 'You have sent too many links recently',
        { retryAfterSeconds, scope },
    );
}

function channelUnavailable(channel: CredentialChannel) {
    return createAppError(
        ERROR_CODES.USER_CHANNEL_UNAVAILABLE,
        409,
        channel === 'telegram'
            ? 'This person has not connected Telegram, so there is no chat to send to'
            : `This person has no ${channel === 'email' ? 'email address' : 'phone number'} on file`,
        { channel },
    );
}

function isAppError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && 'statusCode' in error;
}

/** `jean.dupont@example.com` → `j••••t@example.com`. Enough to recognise, not to retype. */
function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '••••';
    if (local.length <= 2) return `${local[0] ?? '•'}••••@${domain}`;
    return `${local[0]}••••${local[local.length - 1]}@${domain}`;
}

/** `+237600124417` → `+2376••••4417`. Same shape the payout-destination reveal uses. */
function maskPhone(phone: string): string {
    if (phone.length <= 8) return '••••';
    return `${phone.slice(0, 5)}••••${phone.slice(-4)}`;
}

export const adminCredentialDeliveryService = new AdminCredentialDeliveryService();
