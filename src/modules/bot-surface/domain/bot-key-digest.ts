import { createHash } from 'crypto';

/**
 * The digest under which a value is stored as part of a REDIS KEY NAME.
 *
 * ── Key names reach the operations surface; values do not ────────────────────
 * `GET /api/internal/admin/system/cache/keys` lists key NAMES, types and TTLs for any
 * catalogued database, and deliberately offers no single-key value read — that would be a
 * disclosure oracle. So the asymmetry is already built into the platform: a name is
 * semi-public to operators, a value is not.
 *
 * On this surface the thing that would otherwise sit in a key name is a **messaging
 * identity** — a real person's WhatsApp number or Telegram chat id. `GET /api/me/
 * connections` will not return one even to its owner (`identityHint` is `••••1234` or
 * `@handle`, and nothing else leaves the service), so putting one in a listable key name
 * would make the operations surface the first place a raw identifier is stored in the
 * clear. The `Idempotency-Key` is hashed alongside it because it is caller-chosen and may
 * carry anything, including a conversation id.
 *
 * SHA-256, unsalted and unstretched, on purpose: this is a lookup key, not a password
 * hash. A salt would break the lookup and a KDF would only slow the request path down.
 * Against a guessable input — and a phone number is guessable — it buys pseudonymity in
 * an operational listing rather than secrecy, which is exactly what it is for.
 *
 * ── Why this is a deliberate copy of four lines rather than an import ────────
 * `messaging-login/domain/login-token.ts` has the identical function and does not export
 * it from that module's barrel, which is correct: that file is about sign-in credentials,
 * and its digest is documented as protecting a live session token. Reaching past the
 * barrel for it would couple this surface to a module it otherwise touches only through
 * `LoginIdentityResolver`, and would make a future change to one feature's key hashing a
 * silent change to the other's. The shared thing is the platform RULE — key names are
 * listable — and that rule is stated in both places.
 */
export function digestForKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * A stable fingerprint of one request's arguments.
 *
 * Used to tell a genuine retry from a caller that reused an `Idempotency-Key` for a
 * different request. Object keys are sorted before serialisation, because
 * `JSON.stringify` preserves insertion order and two encoders of the same call may not
 * agree on it — a retry that fingerprinted differently would be refused as a reuse, which
 * is the worst possible failure for a mechanism whose whole job is to make retries safe.
 *
 * `undefined` values are dropped rather than serialised, for the same reason: a caller
 * that omits an optional key on one attempt and sends it as `undefined` on the next is
 * making the same request.
 */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
    return digestForKey(`${method.toUpperCase()} ${path} ${stableStringify(body)}`);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

    return `{${entries.join(',')}}`;
}
