/**
 * Forgotten-password recovery.
 *
 * Until now there was none — a full-repo grep for `forgot.password|reset.password` returned
 * nothing but comments. `PATCH /api/me/password` requires the **old** password, and the only
 * other way to change a login identifier is an admin-only route on the internal service
 * surface. For a storefront whose customers sign in rarely, that meant a forgotten password
 * was a permanent lockout with no self-service path back.
 *
 * ── The three security properties, and why each is shaped this way ──────────
 *
 * **1. `requestReset` always reports success.** Whether or not the identifier matches an
 * account, the caller gets the same 200 and the same body. Any difference — a 404, a
 * different message, even a *measurably* different response time on the cheap path — turns
 * the endpoint into an account-enumeration oracle: an attacker feeds it a list of phone
 * numbers and learns which ones bank here. That is why the "no such user" branch returns
 * quietly rather than throwing.
 *
 * **2. The token is single-use and consumed before the write.** It is deleted from Redis the
 * moment it is redeemed, ahead of the password update — the same order `verifyEmail` uses.
 * If the update then fails, the customer must request a new link, which is the safe
 * direction to fail: the alternative leaves a live token that has already been seen.
 *
 * **3. The write goes through `UserRepository.updatePassword`, and must.** That method
 * stamps `password_changed_at` in the *same* `$set` as the hash, and `core/auth/password-epoch.ts`
 * refuses any token issued before that instant. So resetting a password evicts every session
 * the attacker holds — which is the entire point of a reset after a compromise. Writing the
 * hash any other way here would silently skip the revocation, and
 * `npm run test:password-epoch` scans for exactly that.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It does not sign the caller in. A reset link arrives over email or WhatsApp, both of which
 * can be read on a device that is not the one asking — issuing a session on redemption would
 * hand it to whoever opened the message. The customer signs in with their new password,
 * through the path that already exists.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging';
import { getRedisClient, EMAIL_VERIFY_DB } from '../../../infra/redis/redis.factory';
import { UserRepository } from '../../users/user.repository';
import { MailService } from '../../mail/mail.service';
import { isEmailAddress, normalizeEmailAddress } from '../../../core/validation/email';
import { normalizePhoneNumber } from '../../../core/validation/phone';

/**
 * Short, because a reset link is a live credential sitting in an inbox.
 *
 * Long enough for someone to switch devices and find the message; short enough that a mailbox
 * compromised next week is not also an account compromise. The email-verification token lives
 * 24 hours, which is right for a link that only confirms an address and grants nothing.
 */
const RESET_TOKEN_TTL_SECONDS = 30 * 60;

/** The same number in the units every message quotes it in. Exported for the bot reply. */
export const RESET_TOKEN_TTL_MINUTES = RESET_TOKEN_TTL_SECONDS / 60;

/**
 * Reuses the email-verification database with its own key prefix.
 *
 * A new Redis DB index would have to be added to `REDIS_DB_CATALOG`, which three separate
 * features iterate (`/system/dependencies`, `/system/cache`, the flush allowlist) — real
 * cost for no isolation benefit, since both key spaces are short-lived auth tokens with the
 * same blast radius.
 */
const RESET_DB = EMAIL_VERIFY_DB;
const RESET_KEY_PREFIX = 'password_reset:';

/** bcrypt cost. Matches `UserService.changePassword` (12), NOT `register` (10). */
const BCRYPT_ROUNDS = 12;

interface ResetTokenPayload {
    userId: string;
}

export class PasswordResetService {
    constructor(
        private readonly userRepo: UserRepository = new UserRepository(),
        private readonly mailService: MailService = new MailService(),
    ) { }

    /**
     * Start a reset. **Always resolves successfully** — see property 1 in the header.
     *
     * `identifier` is an email address or an E.164 phone number, normalised exactly as
     * `login` normalises it so the same string finds the same account.
     */
    async requestReset(identifier: string): Promise<void> {
        const isEmail = identifier.includes('@');
        const normalized = isEmail ? normalizeEmailAddress(identifier) : normalizePhoneNumber(identifier);

        const user = isEmail
            ? await this.userRepo.findByEmail(normalized)
            : await this.userRepo.findByPhone(normalized);

        if (!user) {
            // Deliberately silent. Logged at info so an operator can still see reset
            // pressure against unknown identifiers, which is a useful abuse signal.
            logger().info({ isEmail }, 'password reset requested for an unknown identifier');
            return;
        }

        /**
         * A suspended account cannot be reset back into.
         *
         * Same silent treatment as an unknown identifier — saying "this account is
         * suspended" to an unauthenticated caller is the enumeration leak again, in a form
         * that also confirms the account exists.
         */
        if (user.status !== 'active') {
            logger().info({ userId: String(user._id) }, 'password reset requested for a non-active account');
            return;
        }

        const token = await this.mintToken(String(user._id));
        await this.deliver(user, token);
    }

    /**
     * Mint a reset link and RETURN it, delivering nothing.
     *
     * ── Why this exists beside `requestReset` ───────────────────────────────────
     * The bot commands (`/reset-password` on WhatsApp and Telegram) reply *in the chat the
     * request came from*, so there is nothing to deliver — the automation layer relays the
     * message, exactly as it does for `/connect` and `/login`. Sending an email as well would
     * be a second delivery path with a second failure mode for a link the person is already
     * looking at.
     *
     * ── The enumeration protection does NOT apply here, and that is not a weakening ──
     * `requestReset` must answer identically for a real and an imaginary account because its
     * caller is an anonymous HTTP client who can feed it a list of phone numbers. The bot
     * caller has *already proved* they control the messaging account — WhatsApp's sender id is
     * the number, and Telegram's contact is verified at signup — so telling them their own
     * number is unrecognised discloses nothing they could not establish anyway. That is the
     * same reasoning `/login` uses.
     *
     * **The caller owns the gating.** This method mints for the user it is handed; it does not
     * re-check `status`, because its caller has just resolved and judged the account and would
     * have to phrase the refusal for a chat window anyway. `resetPassword` re-checks at
     * redemption regardless, which is the check that actually matters.
     *
     * ⚠ **No identity-scoped revocation, deliberately.** `/login`'s credentials revoke their
     * predecessor because a 40-bit code's guessable population must stay flat. A reset token is
     * 32 random bytes — 2^256 — so several live at once is not a guessing risk, they lapse in
     * 30 minutes, and the email/WhatsApp path above has never revoked either. Adding it on one
     * path only would make the two disagree for no gain.
     */
    async issueResetLinkFor(user: { _id: unknown }): Promise<string> {
        const token = await this.mintToken(String(user._id));
        return buildResetLink(token);
    }

    /** One token shape, one TTL, one key space — whoever asked for it. */
    private async mintToken(userId: string): Promise<string> {
        const token = crypto.randomBytes(32).toString('hex');
        const redis = await getRedisClient(RESET_DB);
        const payload: ResetTokenPayload = { userId };
        await redis.set(`${RESET_KEY_PREFIX}${token}`, JSON.stringify(payload), { EX: RESET_TOKEN_TTL_SECONDS });
        return token;
    }

    /**
     * Send the link over whatever channel we can reach this person on.
     *
     * **WhatsApp first when a number is on file**, because `phone` is the required
     * registration field here and `email` is optional — an email-only reset would be
     * undeliverable for a large share of this audience. Both channels are attempted when
     * both identifiers exist; a customer who has lost access to one still gets in.
     *
     * Delivery failure never propagates: `requestReset` must answer identically whether or
     * not the account exists, and an exception escaping here would break that by making a
     * real account slower or louder than an imaginary one.
     */
    private async deliver(user: { _id: unknown; login_email?: string | null; login_phone?: string | null }, token: string): Promise<void> {
        const link = buildResetLink(token);
        const minutes = RESET_TOKEN_TTL_MINUTES;

        if (user.login_email) {
            try {
                await this.mailService.send({
                    to: user.login_email,
                    type: 'AUTH',
                    subject: 'Reset your password',
                    template: 'reset-password',
                    variables: { link, minutes, year: new Date().getFullYear() },
                });
            } catch (error) {
                logger().warn({ err: error }, 'password reset email delivery failed');
            }
        }

        if (user.login_phone) {
            try {
                // Imported lazily: the WhatsApp module pulls in the messaging stack and its
                // config, and auth must stay loadable without it (WhatsApp is optional).
                const { WhatsAppServiceMessenger } = await import('../../whatsapp/services/whatsapp-service-messenger');
                await new WhatsAppServiceMessenger().sendText({
                    to: user.login_phone,
                    body: `Reset your Jovi Mall password: ${link}\n\nThis link expires in ${minutes} minutes. If you did not ask for it, ignore this message — your password has not changed.`,
                    previewUrl: false,
                });
            } catch (error) {
                logger().warn({ err: error }, 'password reset WhatsApp delivery failed');
            }
        }
    }

    /**
     * Redeem a token and set the new password.
     *
     * The one place in this flow that raises: by the time somebody is on the reset form they
     * hold a token, so telling them it has expired is actionable and leaks nothing they did
     * not already have.
     */
    async resetPassword(token: string, newPassword: string): Promise<void> {
        const redis = await getRedisClient(RESET_DB);
        const key = `${RESET_KEY_PREFIX}${token}`;
        const raw = await redis.get(key);

        if (!raw) {
            throw createAppError(ERROR_CODES.AUTH_RESET_TOKEN_INVALID, 400);
        }

        // Consumed BEFORE the write — single-use even if what follows fails. Failing towards
        // "request another link" is the safe direction; leaving a spent token live is not.
        await redis.del(key);

        let payload: ResetTokenPayload;
        try {
            payload = JSON.parse(raw) as ResetTokenPayload;
        } catch {
            throw createAppError(ERROR_CODES.AUTH_RESET_TOKEN_INVALID, 400);
        }

        const user = await this.userRepo.findById(payload.userId);
        if (!user) {
            throw createAppError(ERROR_CODES.AUTH_RESET_TOKEN_INVALID, 400);
        }
        // A closed account cannot be reset back into, and says so distinctly: a reset link
        // minted before the closure is exactly the credential somebody would try next.
        if (user.status === 'closed') {
            throw createAppError(ERROR_CODES.AUTH_ACCOUNT_CLOSED, 403);
        }
        // Re-checked at redemption, not just at request: an account can be suspended in the
        // window between the two, and a valid token must not outlive that decision.
        if (user.status !== 'active') {
            throw createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended');
        }

        const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

        // ⚠️ MUST go through this method — it stamps `password_changed_at` in the same `$set`
        // as the hash, which is what revokes every existing session. See the header.
        await this.userRepo.updatePassword(payload.userId, hash);

        logger().info({ userId: payload.userId }, 'password reset completed');
    }
}

/**
 * Where the reset link points.
 *
 * The **storefront**, not this API: unlike email verification — whose link is a `GET` this
 * service answers directly — a reset needs a form for the new password, and only the
 * frontend has one. Falls back to `API_PUBLIC_URL` so a misconfigured deploy produces a
 * visibly wrong link rather than `undefined/reset-password`.
 */
function resetLinkBase(): string {
    const base = process.env.STOREFRONT_URL || process.env.API_PUBLIC_URL || '';
    return base.replace(/\/+$/, '');
}

/**
 * The reset URL for a token. One builder, so the email, the WhatsApp message and the bot
 * reply cannot drift on the path or the query parameter.
 *
 * ── Link previews are HARMLESS here, unlike the magic link's ────────────────
 * WhatsApp and Telegram fetch URLs to build preview cards. That is fatal for a magic
 * sign-in link, which is why `/login`'s points at a page that must POST — a crawler would
 * otherwise spend the token before the user tapped.
 *
 * This link is safe because the token is spent by `POST /auth/reset-password`, which only
 * runs when a human submits the new-password form. A crawler that fetches the page changes
 * nothing. Previews are still worth disabling on the bot reply for tidiness, not for safety.
 */
export function buildResetLink(token: string): string {
    return `${resetLinkBase()}/reset-password?token=${token}`;
}

export const passwordResetService = new PasswordResetService();
