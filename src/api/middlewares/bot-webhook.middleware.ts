import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * Shared-secret authentication for the two bot webhooks.
 *
 * ── WHY THIS EXISTS NOW, AND DID NOT BEFORE ──────────────────────────────────
 * `POST /api/webhooks/{whatsapp,telegram}` have always been unauthenticated — no
 * signature, no secret, unlike the geo-tracker webhook (HMAC-SHA256) and the
 * payment webhooks (per-gateway signature verification). While they only *redeemed*
 * a code that was tolerable: an attacker needed the code, and the code came from us.
 *
 * `/connect` changed what the endpoint is. It **mints** a credential, for whatever
 * identity the request names. Left open, anyone who can reach the host can:
 *
 *   POST /api/webhooks/whatsapp  { is_command: true, command: "connect", ... }
 *   with `reply_to` set to somebody else's number
 *
 * …and read that person's connection code straight out of the response, then bind
 * their WhatsApp account to the attacker's own. It is not a platform-account
 * takeover — the victim's account is untouched — but it silently redirects their
 * notifications and, because `(channel, external_id)` is unique, it locks the real
 * owner out of ever connecting. That is worth a header.
 *
 * ── THE UNSET BEHAVIOUR IS THE DECISION, AND IT CHANGED (GAP-011) ────────────
 * ⛔ **It is now REQUIRED IN EVERY ENVIRONMENT.** It used to fail closed in
 * production and open in development, on the argument that the development
 * exemption bought convenience and cost nothing: an attacker on a laptop could
 * mint a connection code against a stranger's number, which is bad but bounded.
 *
 * **GAP-002 removed the bound.** Registration is dispatchable now — and, since the
 * product owner's 2026-08-26 decision, dispatchable with NO CONSENT STEP, on the
 * sender's first message. An open webhook therefore lets anybody create platform
 * accounts against strangers' phone numbers, at scale, from a laptop, in one
 * request each. That is not a development convenience with a small blast radius;
 * it is a way to poison the `users` table of any environment sharing a database
 * with anything, and it would do so silently.
 *
 * GAP-011 offered two resolutions — require it everywhere, or require it only when
 * a registration-capable command is registered. **The first was taken.** The second
 * makes the guard's strength depend on a route table somebody may extend without
 * noticing, which is precisely the class of mistake this exists to prevent, and it
 * saves one line in `.env`.
 *
 * ⚠ **Setting `BOT_WEBHOOK_SECRET` requires the same value on the n8n side**, as an
 * `X-Webhook-Secret` header. Deploying this without configuring the bridge stops
 * `/connect` AND the whole bot surface working — the failure is loud and immediate,
 * not silent, which is the right direction for a change of this kind.
 */

const HEADER = 'x-webhook-secret';

/** Constant-time compare, so a wrong secret cannot be found a byte at a time. */
function matches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    // `timingSafeEqual` throws on a length mismatch, which would itself leak the
    // length. Compare the lengths first and always run the digest compare.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function botWebhookSecretConfigured(): boolean {
    return Boolean(process.env.BOT_WEBHOOK_SECRET?.trim());
}

/**
 * Reports the guard's state at boot, so an operator sees it in the log rather than
 * discovering it. Called from `startServer()` beside the other assertions.
 */
export function reportBotWebhookGuard(log: (message: string) => void): void {
    if (botWebhookSecretConfigured()) {
        log('[BotWebhook] shared-secret guard ACTIVE on /api/webhooks/{whatsapp,telegram} and /api/internal/bot/*');
        return;
    }

    log(
        '[BotWebhook] ⚠ BOT_WEBHOOK_SECRET is not set. The bot webhooks and the whole bot '
        + 'surface REFUSE every request — in EVERY environment since GAP-011, because '
        + 'registration is dispatchable and an open webhook creates accounts against '
        + 'strangers\' numbers. Set it here and on the automation layer.',
    );
}

/**
 * ⛔ **No environment branch. An unset secret refuses, everywhere.**
 *
 * The old `NODE_ENV === 'production'` condition was GAP-011's subject and is gone; see the
 * file header for why registration removed the argument for it. Do not re-add it — a guard
 * whose failure direction is "open on a missing variable" is what `config/env.ts`'s own
 * header exists to argue against, and here that open direction mints accounts.
 */
export function requireBotWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
    const expected = process.env.BOT_WEBHOOK_SECRET?.trim();

    if (!expected) {
        // Fail closed. The message says what is wrong to OUR operator via the log; the
        // client gets the registry default, because `internal` and `external_service`
        // categories are message-substituted at the boundary and this one is deliberately
        // not descriptive on the wire either.
        return next(createAppError(
            ERROR_CODES.WEBHOOK_SECRET_INVALID,
            401,
            undefined,
            { reason: 'not_configured' },
        ));
    }

    const presented = req.get(HEADER);
    if (!presented || !matches(presented, expected)) {
        return next(createAppError(ERROR_CODES.WEBHOOK_SECRET_INVALID, 401));
    }

    return next();
}

/**
 * Refuse the BOOT when the secret is unset — GAP-011's "pin it with a boot assertion".
 *
 * The middleware above already fails closed, so this is not what makes the door safe. What
 * it buys is finding out at deploy time rather than on the first customer message: without
 * it, a misconfigured instance comes up healthy, passes its readiness probe, and answers
 * `401` to every inbound message with the only symptom being a log line nobody is watching.
 * Same shape as `assertSigningSecrets()` and `assertUploadScannerSafe()`, beside which it
 * runs.
 */
export function assertBotWebhookSecretConfigured(): void {
    if (botWebhookSecretConfigured()) return;

    // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
    throw new Error(
        '[BotWebhook] BOT_WEBHOOK_SECRET is not set. It is REQUIRED in every environment '
        + '(GAP-011): the bot webhooks mint connection codes and, since GAP-002, create '
        + 'customer accounts, so an open endpoint creates accounts against strangers\' '
        + 'phone numbers. Set the same value here and on the automation layer.',
    );
}
