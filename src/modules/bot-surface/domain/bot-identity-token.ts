import { createCipheriv, createDecipheriv, createHmac } from 'crypto';
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
 *   1. **Unforgeable.** Authenticated encryption (AES-256-GCM). A model that invents a
 *      token, or alters one it was given, produces bytes that do not authenticate — so it
 *      cannot name a customer it was not handed.
 *   2. **Expiring.** A leaked token is a bounded liability rather than a permanent one.
 *      `/identity/sync` runs on EVERY message, so a fresh token reaches the conversation
 *      each turn and the TTL never has to be generous to be usable.
 *   3. **Opaque.** It goes into a model's context window, chat memory and n8n execution
 *      logs, and none of those becomes a place where a real person's messaging identifier
 *      sits in a form a reader — or a model — can recover.
 *   4. **Stable within the hour.** See v2 below; it is what makes a copy from chat memory
 *      the SAME string as the fresh one.
 *
 * ── v2, AND THE MEASURED REASON v1 WAS REPLACED (2026-09-21) ─────────────────
 * v1 was `v1.<base64url JSON>.<HMAC>`. Property 3 above was claimed for it and was FALSE:
 * base64 is an encoding, not a seal, and the middle segment decoded to
 * `{"c":"whatsapp","e":"2376…","x":<expiry>}` — readable by anyone, and readable by the model.
 * The model acted on that. Across the owner's handset tests (n8n executions 1398, 1415, 1426,
 * 1439, 1443, 1505) it repeatedly did not COPY the token from its prompt: it REBUILT one —
 * channel and number intact, the expiry moved a day or more ahead, the signature invented —
 * and every such call was refused. The chat memory made it worse: it replays every earlier
 * tool call WITH its token, so the model saw five or six different ~150-character lookalikes
 * beside the one fresh value. A prompt rule ("copy it exactly, retry once") did not hold.
 *
 * v2 removes what the model was acting on, rather than asking it to behave:
 *   - **Encrypted**, so there is no expiry to "update" and no structure to rebuild.
 *   - **Deterministic within a clock hour** — the nonce is derived from the plaintext, and
 *     the plaintext carries the hour, not the second — so every token minted for one customer
 *     in one hour is BYTE-IDENTICAL. The copies in chat memory are the fresh value.
 *   - **About half as long** (~90 characters, not ~150), and fewer characters to copy is
 *     fewer to get wrong.
 * Deterministic encryption reveals only that two tokens are equal, and equal tokens mean the
 * same customer in the same hour — which is exactly what the logs already say.
 *
 * ⚠ **v1 is no longer accepted** (removed 2026-09-21). It was read for a while after v2 went
 * live, so the tokens already sitting in chat memory at the deploy kept working; every v1
 * token lived at most two hours, and the branch was deleted six hours after the deploy, when
 * it could only ever refuse. A v1 token now answers INVALID, which the prompt's retry-once
 * rule handles exactly as it handles EXPIRED.
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
 * The SHORTEST time a minted token stays valid.
 *
 * Two hours, and short enough that a token scraped from a log is worthless by the time anybody
 * reads it. It does not need to cover a whole conversation — every inbound message re-mints
 * one. ⚠ Since v2 it is a floor, not an exact lifetime: a token expires two hours after the
 * END of the clock hour it was minted in, so it lives between two and three hours. That is the
 * price of being identical all hour, and it is why a copy from the previous hour still verifies.
 */
export const BOT_IDENTITY_TOKEN_TTL_SECONDS = 7200;

/** The window within which every token for one customer is the same string. */
export const BOT_IDENTITY_TOKEN_BUCKET_SECONDS = 3600;

/** The version this build mints and reads. A future shape gets `v3`, never a flag. */
const VERSION = 'v2';

const NONCE_BYTES = 12;
const TAG_BYTES = 12;

/**
 * Two keys derived from the one secret, so v2 needs no new environment variable and rotates
 * with `BOT_IDENTITY_TOKEN_SECRET` exactly as v1 did. Separate keys for the cipher and for
 * the nonce: the nonce is a MAC of the plaintext, and a key must never serve two purposes.
 */
function subkey(purpose: 'encryption' | 'nonce'): Buffer {
    return createHmac('sha256', getBotIdentityTokenSecret())
        .update(`wi-mall bot identity token ${VERSION} ${purpose}`)
        .digest();
}

/** What a verified token unseals to — exactly the envelope fields it sealed. */
export interface UnsealedBotIdentity {
    channel: MessagingChannel;
    externalId: string;
    language: string | null;
}

/**
 * The v2 plaintext: `[channel, externalId, expiryHour, language]`, as JSON.
 *
 * `expiryHour` is hours since the epoch, never seconds — the whole point is that two mints in
 * the same hour produce the same bytes. `language` is `''` when absent so the array always has
 * four entries.
 */
type SealedTuple = [string, string, number, string];

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
    const hour = Math.floor(now / BOT_IDENTITY_TOKEN_BUCKET_SECONDS);
    const expiryHour = hour + 1 + BOT_IDENTITY_TOKEN_TTL_SECONDS / BOT_IDENTITY_TOKEN_BUCKET_SECONDS;

    const tuple: SealedTuple = [input.channel, input.externalId, expiryHour, input.language ?? ''];
    const plaintext = Buffer.from(JSON.stringify(tuple), 'utf8');

    /**
     * ⚠ **The nonce is derived from the plaintext, and that is deliberate** — it is what makes
     * the token identical all hour (the "synthetic IV" construction). GCM's one catastrophic
     * misuse is the same nonce with DIFFERENT plaintexts; here a nonce can only repeat when the
     * plaintext does, which yields the same ciphertext and reveals nothing new.
     */
    const nonce = createHmac('sha256', subkey('nonce')).update(plaintext).digest().subarray(0, NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', subkey('encryption'), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(VERSION));
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return `${VERSION}.${Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64url')}`;
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
    const at = now ?? Math.floor(Date.now() / 1000);

    if (parts.length === 2 && parts[0] === VERSION) return unsealV2(parts[1], at);
    throw invalidToken();
}

function unsealV2(body: string, at: number): UnsealedBotIdentity {
    const bytes = Buffer.from(body, 'base64url');

    /**
     * ⚠ **Checked before any slicing**: a token cut short must be a 401, never a fault on the
     * refusal path. `setAuthTag` and the decipher both
     * throw on malformed input, and a throw here would be a 500 anyone could provoke.
     */
    if (bytes.length < NONCE_BYTES + TAG_BYTES + 1) throw invalidToken();

    let plaintext: string;
    try {
        const nonce = bytes.subarray(0, NONCE_BYTES);
        const tag = bytes.subarray(bytes.length - TAG_BYTES);
        const sealed = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', subkey('encryption'), nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(VERSION));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8');
    } catch {
        // Did not authenticate: invented, edited, truncated, or sealed under another secret.
        throw invalidToken();
    }

    let tuple: unknown;
    try {
        tuple = JSON.parse(plaintext);
    } catch {
        // Authenticated, so this is our own malformed mint rather than an attack — still a 401.
        throw invalidToken();
    }

    if (
        !Array.isArray(tuple)
        || tuple.length !== 4
        || typeof tuple[0] !== 'string'
        || typeof tuple[1] !== 'string'
        || !Number.isInteger(tuple[2])
        || typeof tuple[3] !== 'string'
        || !(CONNECTION_CHANNELS as readonly string[]).includes(tuple[0])
        || tuple[1].length === 0
        || tuple[1].length > 128
    ) {
        throw invalidToken();
    }

    const [channel, externalId, expiryHour, language] = tuple as SealedTuple;
    if (expiryHour * BOT_IDENTITY_TOKEN_BUCKET_SECONDS <= at) throw expiredToken();

    return {
        channel: channel as MessagingChannel,
        externalId,
        language: language === '' ? null : language,
    };
}

function expiredToken() {
    return createAppError(
        ERROR_CODES.BOT_IDENTITY_TOKEN_EXPIRED,
        401,
        'The sealed identity token has expired',
    );
}

function invalidToken() {
    return createAppError(
        ERROR_CODES.BOT_IDENTITY_TOKEN_INVALID,
        401,
        'The sealed identity token is not valid',
    );
}
