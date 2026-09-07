import { createHmac, timingSafeEqual } from 'crypto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getBotIdentityTokenSecret } from '../../../config/secrets.config';
import { CONNECTION_CHANNELS, MessagingChannel } from '../../channel-connections';

/**
 * The sealed identity token — the ONE form of a messaging identity a model may hold.
 *
 * ── WHY THIS EXISTS, AND WHY NOTHING ELSE WOULD DO ───────────────────────────
 * Every route on this surface resolves its caller from the `identity` envelope the
 * transport attaches, and `bot-identity.service.ts` states the rule that makes that safe:
 * **the identity is never a parameter**, because on a surface reaching carts, orders and
 * addresses a caller-supplied identity is account takeover rather than a leak.
 *
 * That rule was free while the transport was an n8n workflow, which builds the envelope
 * from its own trigger data and never asks the model. It stops being free the moment the
 * transport is an **MCP server**: n8n's MCP Server Trigger hands a connected tool node NO
 * per-request context — no query string, no headers — and the trigger itself executes
 * AFTER the tool, so `$('MCP Server Trigger')` raises "hasn't been executed". Measured on
 * the live instance, 2026-09-06. The model's arguments are the only channel from client to
 * tool that exists.
 *
 * So the envelope has to travel through the model. A RAW envelope there would hand every
 * prompt injection a working account-takeover primitive — "use externalId 123456789" —
 * which is the precise failure the rule above exists to prevent.
 *
 * This is the narrow thing that can travel instead: an opaque string the model can only
 * ECHO, never author. It carries the identity, it is signed, and a caller that edits one
 * byte of it holds nothing.
 *
 * ── THE THREE PROPERTIES THAT MAKE IT SAFE ───────────────────────────────────
 *
 *   1. **Unforgeable.** HMAC-SHA256 over the payload. A model that invents a token, or
 *      alters the `externalId` inside one it was given, produces a signature that does not
 *      verify — so it cannot name a customer it was not handed.
 *   2. **Expiring.** A leaked token is a bounded liability rather than a permanent one.
 *      `/identity/sync` runs on EVERY message, so a fresh token reaches the conversation
 *      each turn and the TTL never has to be generous to be usable.
 *   3. **Opaque.** It is not a phone number. It goes into a model's context window, chat
 *      memory and n8n execution logs, and none of those becomes a place where a real
 *      person's messaging identifier sits in the clear.
 *
 * ⚠ **This is NOT a session, and it must never grow into one.** It authenticates nothing
 * on its own: it is a sealed restatement of the envelope the automation layer could
 * already have sent, consumed by the same resolver, behind the same two credentials
 * (`INTERNAL_SERVICE_TOKEN` + `BOT_WEBHOOK_SECRET`). Holding one is worth exactly nothing
 * without both. That is what keeps `bot.routes.ts`' "not a session mint" promise true — a
 * compromised automation layer still cannot become a credential store, because these are
 * not customer credentials.
 *
 * ⚠ **NOT a cross-service shared secret, and that was a design goal.** jovi-mall both
 * signs and verifies; the automation layer only relays. So this adds nothing to the five
 * shared values in the workspace CLAUDE.md and nothing to the rotation runbook — the
 * secret rotates here alone, and the only cost is that tokens minted before the rotation
 * stop verifying, which is one turn's inconvenience and self-heals on the next
 * `/identity/sync`.
 */

/**
 * How long a minted token stays valid.
 *
 * Two hours: comfortably longer than the n8n chat memory's own hour, so a conversation
 * cannot outlive its token mid-turn, and short enough that a token scraped from a log is
 * worthless by the time anybody reads it. It does not need to cover a whole conversation —
 * every inbound message re-mints one.
 */
export const BOT_IDENTITY_TOKEN_TTL_SECONDS = 7200;

/** The only version this build mints or accepts. A future shape gets `v2`, never a flag. */
const VERSION = 'v1';

/**
 * The sealed payload.
 *
 * Single-letter keys, because this string is repeated into a model's context window on
 * every tool call and the field names carry no meaning to any reader but this file.
 */
interface SealedPayload {
    /** channel */
    c: string;
    /** externalId */
    e: string;
    /** expires at, seconds since the epoch */
    x: number;
    /** language hint, carried so a refusal before resolution is still worded in it */
    l?: string;
}

/** What a verified token unseals to — exactly the envelope fields it sealed. */
export interface UnsealedBotIdentity {
    channel: MessagingChannel;
    externalId: string;
    language: string | null;
}

function encode(input: string): string {
    return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
    return createHmac('sha256', getBotIdentityTokenSecret()).update(payload).digest('base64url');
}

/**
 * Seal a messaging identity into a token.
 *
 * Called only where a customer has already been RESOLVED — there is deliberately no way to
 * mint one for a sender the platform does not know, because a token for an unresolvable
 * identity would be a signed statement about nobody.
 */
export function sealBotIdentity(input: {
    channel: MessagingChannel;
    externalId: string;
    language?: string | null;
    /** Overridable for tests only. Seconds since the epoch. */
    now?: number;
}): string {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const payload: SealedPayload = {
        c: input.channel,
        e: input.externalId,
        x: now + BOT_IDENTITY_TOKEN_TTL_SECONDS,
    };
    if (input.language) payload.l = input.language;

    const encoded = encode(JSON.stringify(payload));
    return `${VERSION}.${encoded}.${sign(encoded)}`;
}

/**
 * Unseal a token, or throw the refusal a caller should see.
 *
 * ⚠ **Every failure path is a 401, and none of them says why in a way a caller could use
 * to probe.** "Expired" and "not a real signature" are separate codes because a client's
 * correct response differs — one is "re-read the token you were given", the other is "you
 * are doing something you should not" — but neither carries the payload, the channel, or
 * any hint about whose token it might have been.
 */
export function unsealBotIdentity(token: string, now?: number): UnsealedBotIdentity {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) throw invalidToken();

    const encoded = parts[1];
    const provided = Buffer.from(parts[2], 'base64url');
    const expected = Buffer.from(sign(encoded), 'base64url');

    /**
     * ⚠ **The length check is not redundant; it is what makes the comparison legal.**
     * `timingSafeEqual` THROWS on buffers of different lengths, so a caller sending a
     * short signature would get a 500 rather than a 401 — a fault on the refusal path,
     * available to anyone who wants one.
     */
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw invalidToken();
    }

    let payload: SealedPayload;
    try {
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SealedPayload;
    } catch {
        // The signature verified, so this is our own malformed mint rather than an attack.
        // It is still a token this request cannot use, and still a 401 to the caller.
        throw invalidToken();
    }

    if (
        typeof payload?.c !== 'string'
        || typeof payload?.e !== 'string'
        || typeof payload?.x !== 'number'
        || !(CONNECTION_CHANNELS as readonly string[]).includes(payload.c)
        || payload.e.length === 0
        || payload.e.length > 128
    ) {
        throw invalidToken();
    }

    const at = now ?? Math.floor(Date.now() / 1000);
    if (payload.x <= at) {
        throw createAppError(
            ERROR_CODES.BOT_IDENTITY_TOKEN_EXPIRED,
            401,
            'The sealed identity token has expired',
        );
    }

    return {
        channel: payload.c as MessagingChannel,
        externalId: payload.e,
        language: typeof payload.l === 'string' ? payload.l : null,
    };
}

function invalidToken() {
    return createAppError(
        ERROR_CODES.BOT_IDENTITY_TOKEN_INVALID,
        401,
        'The sealed identity token is not valid',
    );
}
