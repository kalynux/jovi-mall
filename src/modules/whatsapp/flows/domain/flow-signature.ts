import { createHmac, timingSafeEqual } from 'crypto';

/**
 * `X-Hub-Signature-256` — proof the request came from Meta rather than from somebody holding
 * our public key.
 *
 * ── WHY THIS EXISTS WHEN THE BODY IS ALREADY ENCRYPTED ──────────────────────
 * The cipher proves the sender could encrypt to our **public** key, and a public key is not a
 * secret by construction — treating it as one is the mistake this check exists to avoid. The
 * HMAC is computed with the **App Secret**, which only Meta and this deployment hold, so it
 * is the part that actually authenticates the caller.
 *
 * This service's own precedent is unambiguous about the posture. `payments/` says webhook
 * verification "is on the interface, and refusing is not optional", after both mobile-money
 * routes shipped with a method whose first act was a comment saying it skipped verification.
 * A Flows endpoint is the same shape of surface: public, unauthenticated by anything else,
 * and reachable by anyone who finds the URL.
 *
 * ── ⚠ THE RAW BYTES, AND WHY A PARSED BODY CANNOT BE RE-SERIALISED ──────────
 * The HMAC covers the exact bytes Meta sent. `JSON.stringify(req.body)` is not those bytes —
 * key order, whitespace and unicode escaping all differ — so a verifier fed a parsed body
 * refuses every genuine request, and the symptom is indistinguishable from a wrong secret.
 * `app.ts` already carries that warning at length for the payment gateways; this endpoint
 * needs the same raw mount for the same reason.
 */

/** Meta's header format: the hex digest with this prefix. */
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify one signature.
 *
 * ⚠ **`timingSafeEqual`, never `===`** — the same rule `phone-verification/domain/otp.ts`
 * follows, and it is source-scanned there. It throws on a length mismatch, so the lengths are
 * compared first; that comparison leaks only the length of a digest whose length is fixed and
 * public anyway.
 */
export function verifyFlowSignature(
    rawBody: Buffer,
    header: string | undefined,
    appSecret: string,
): boolean {
    if (!header || !header.startsWith(SIGNATURE_PREFIX) || appSecret === '') return false;

    const presented = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');
    const expected = createHmac('sha256', appSecret).update(rawBody).digest();

    if (presented.length !== expected.length) return false;
    return timingSafeEqual(presented, expected);
}

/**
 * The App Secret, or empty when this deployment has not configured one.
 *
 * ⚠ **Read as a spelled-out property access.** `test:env`'s census re-derives every variable
 * `src/` reads, and a name reaching `process.env` through a helper that takes it as an
 * argument is invisible to it — which fails the suite in the undocumented direction.
 */
export function flowAppSecret(): string {
    return process.env.WHATSAPP_APP_SECRET || '';
}
