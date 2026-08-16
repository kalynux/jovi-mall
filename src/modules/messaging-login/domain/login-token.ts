import { randomBytes, createHash } from 'crypto';

/**
 * The magic link's token — an OPAQUE lookup key, deliberately not a JWT.
 *
 * ── WHY NOT A SELF-CONTAINED TOKEN ───────────────────────────────────────────
 * A signed or encrypted token carrying the account would be smaller and would
 * need no Redis. It was rejected on three counts, and the first is fatal to the
 * feature's central promise:
 *
 *   1. **It cannot be revoked.** "Using the code kills the link, and using the
 *      link kills the code" is unimplementable against a token that validates
 *      itself — there is nothing to delete. Single-use would be a claim rather
 *      than a mechanism.
 *   2. **It carries account data into a chat log, a URL bar, and every proxy
 *      in between.** A magic link is pasted, forwarded and screenshotted; an
 *      opaque key discloses nothing to anyone who reads it after it expires.
 *   3. **It needs key management**, and one leaked signing key forges sessions
 *      for every account at once rather than compromising one.
 *
 * An opaque key has nothing to decrypt and is revoked with a `DEL`. Same shape
 * as the password-reset token this service already issues.
 *
 * Pure — no Redis, no Express — so `test:messaging-login` covers it without
 * infrastructure.
 */

/**
 * 32 bytes = 256 bits, rendered base64url as 43 characters.
 *
 * This is the credential a single tap turns into a session, so unlike the
 * 8-character code (which a human retypes and which is therefore bounded by
 * what a person will tolerate), there is no reason to be modest. 2^256 is not
 * guessable by anything, which is what lets the link stand on its own with no
 * second factor and no per-link attempt counter.
 */
export const LOGIN_TOKEN_BYTES = 32;

/** 32 bytes, base64url, unpadded. */
export const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A cryptographically random magic-link token.
 *
 * `randomBytes`, never `Math.random`. `base64url` rather than `hex` because the
 * value travels in a query string — base64url is URL-safe by definition, so no
 * call site has to remember to encode it, and it is a third shorter.
 */
export function generateLoginToken(): string {
  return randomBytes(LOGIN_TOKEN_BYTES).toString('base64url');
}

/** Cheap pre-Redis reject for a value that cannot be one of ours. */
export function isWellFormedLoginToken(value: string): boolean {
  return LOGIN_TOKEN_PATTERN.test(value);
}

/**
 * The digest under which a secret is stored as part of a REDIS KEY NAME.
 *
 * ── Key names reach the operations surface; values do not ────────────────────
 * `GET /api/internal/admin/system/cache/keys` lists key NAMES, types and TTLs
 * for any catalogued database — and it deliberately offers no single-key value
 * read, because that would be a disclosure oracle. So the asymmetry is already
 * built into the platform: a name is semi-public to operators, a value is not.
 *
 * Everything this feature puts in a key name is therefore hashed — the link
 * token, the login code, the messaging identity and the redeeming identifier.
 * A magic-link token sitting in a listable key name is a live session credential
 * readable by anyone with the developer-tools role; a phone number there is
 * personal data in an operational listing. The raw material lives in the record
 * VALUE, which that endpoint cannot return.
 *
 * ⚠ This deliberately goes further than `channel-connections`, whose keys are
 * `connection:code:{CODE}` in the clear. That is not a criticism of it — a
 * connection code grants an account link, not a session — and it is not a
 * reason to copy the weaker shape here.
 *
 * SHA-256 with no salt and no stretching, on purpose: the inputs are 40+ bits
 * of uniform randomness with a ten-minute life, so this is a lookup key, not a
 * password hash. A salt would break the lookup and a KDF would only slow the
 * redeem path down. The identifier (a phone or email) IS guessable, and hashing
 * it there buys pseudonymity in an ops listing rather than secrecy — which is
 * exactly what it is for.
 */
export function digestForKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The id tying one record to its pointers. Random, never derived.
 *
 * Not the user id: a session id derived from the account would let anyone who
 * can list key names learn which accounts are signing in, and would collide
 * across two concurrent sign-ins by one person.
 */
export function generateLoginSessionId(): string {
  return randomBytes(16).toString('hex');
}
