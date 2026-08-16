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
 * ── THE UNSET BEHAVIOUR IS THE DECISION ──────────────────────────────────────
 * **Production fails CLOSED, development fails open with a warning.** The split is
 * about blast radius, the same argument `config/env.ts` makes for its own
 * error/warning split:
 *
 *   - In production an open credential minter is the vulnerability above, and
 *     "somebody forgot to set the variable" must not be the thing that decides it.
 *   - In development the automation layer usually is not running at all and the
 *     webhook is driven by curl. Failing closed there buys no safety and teaches
 *     people to disable the guard, which is how a guard stops protecting anything.
 *
 * ⚠ **Setting `BOT_WEBHOOK_SECRET` requires the same value on the n8n side**, as an
 * `X-Webhook-Secret` header. Deploying this without configuring the bridge stops
 * `/connect` working — the failure is loud and immediate, not silent, which is the
 * right direction for a change of this kind.
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
        log('[BotWebhook] shared-secret guard ACTIVE on /api/webhooks/{whatsapp,telegram}');
        return;
    }

    if (process.env.NODE_ENV === 'production') {
        log(
            '[BotWebhook] ⚠ BOT_WEBHOOK_SECRET is not set. In production the bot webhooks '
            + 'REFUSE every request, so /connect will not work until it is configured on '
            + 'this service and on the automation layer.',
        );
        return;
    }

    log(
        '[BotWebhook] ⚠ BOT_WEBHOOK_SECRET is not set — the bot webhooks are OPEN. '
        + 'Acceptable in development; a production deploy refuses them instead.',
    );
}

export function requireBotWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
    const expected = process.env.BOT_WEBHOOK_SECRET?.trim();

    if (!expected) {
        if (process.env.NODE_ENV === 'production') {
            // Fail closed. The message says what is wrong to OUR operator via the log;
            // the client gets the registry default, because `internal` and
            // `external_service` categories are message-substituted at the boundary and
            // this one is deliberately not descriptive on the wire either.
            return next(createAppError(
                ERROR_CODES.WEBHOOK_SECRET_INVALID,
                401,
                undefined,
                { reason: 'not_configured' },
            ));
        }
        return next();
    }

    const presented = req.get(HEADER);
    if (!presented || !matches(presented, expected)) {
        return next(createAppError(ERROR_CODES.WEBHOOK_SECRET_INVALID, 401));
    }

    return next();
}
