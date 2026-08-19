import { createAppError } from '../core/errors';
import { ERROR_CODES } from '../core/error-codes';

/**
 * Signing secrets — resolved once, and **fail closed**.
 *
 * These used to be read inline as `process.env.JWT_SECRET || 'secret'` at six
 * call sites. A deploy that forgot the variable therefore signed and verified
 * every access token with the literal string `'secret'`, which anyone can guess:
 * forging an admin token was a one-liner. The fallback also made the failure
 * invisible — the server booted and behaved normally.
 *
 * geo-tracker holds the same secret and verifies the same tokens. ⚠ This comment used to
 * claim it "already fails closed on an empty secret (`internal/platform/auth/token.go`)".
 * That was **wrong on both counts**: the file is `internal/platform/config/config.go`, and
 * until 2026-08-19 it read `getEnv("JWT_SECRET", "secret")` — so geo-tracker booted happily
 * without the variable, verifying every token against a string anyone can guess, while this
 * service refused to start. It fails closed now, with these same two thresholds, so both
 * halves of the contract really do behave the same way. The lesson is the comment, not the
 * code: a claim about the OTHER repository is an unverified claim, and this one was written
 * by somebody who was not editing it.
 *
 * `assertSigningSecrets()` runs at boot (see `server.ts`) so a misconfigured
 * deployment dies immediately and loudly, rather than at the first request.
 */

const MIN_SECRET_LENGTH = 16;

/** Values that are obviously not a real secret, regardless of length. */
const REJECTED_SECRETS = new Set(['secret', 'changeme', 'password', 'development_secret_do_not_use_in_prod']);

function requireSecret(name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw createAppError(
      ERROR_CODES.CONFIG_MISSING_JWT_SECRET,
      500,
      `${name} is not set. Refusing to sign or verify tokens with a default.`,
      { variable: name },
    );
  }

  if (process.env.NODE_ENV === 'production') {
    if (value.length < MIN_SECRET_LENGTH || REJECTED_SECRETS.has(value.toLowerCase())) {
      throw createAppError(
        ERROR_CODES.CONFIG_MISSING_JWT_SECRET,
        500,
        `${name} is a placeholder or too short (min ${MIN_SECRET_LENGTH} chars) for production.`,
        { variable: name },
      );
    }
  }

  return value;
}

/** Signs and verifies access tokens. Shared verbatim with geo-tracker. */
export function getJwtSecret(): string {
  return requireSecret('JWT_SECRET');
}

/**
 * Signs and verifies refresh tokens.
 *
 * Falls back to `JWT_SECRET` when unset — that fallback is deliberate and is not
 * the one being removed here. Using one secret for both token types is weaker
 * than using two, but it is a real secret either way; `|| 'secret'` was not.
 */
export function getJwtRefreshSecret(): string {
  return process.env.JWT_REFRESH_SECRET?.trim() ? requireSecret('JWT_REFRESH_SECRET') : getJwtSecret();
}

/**
 * Boot guard. Call before the server starts listening so a missing secret is a
 * startup crash, not a 500 on whichever request happens to need a token first.
 */
export function assertSigningSecrets(): void {
  getJwtSecret();
  getJwtRefreshSecret();
}
