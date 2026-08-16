import {
  generateCode,
  isWellFormedCode,
  normalizeCode,
} from '../../channel-connections/domain/connection-code';

/**
 * The 8-character sign-in code — the half of a `/login` reply a human retypes.
 *
 * ── EIGHT CHARACTERS, AND WHY NOT SIX ────────────────────────────────────────
 * Same alphabet as `/connect` (Crockford-style base32, no I/L/O/U), same
 * unbiased sampling, same normaliser — all shared from
 * `channel-connections/domain/connection-code.ts` rather than copied. Only the
 * length differs, and it differs because the blast radius does:
 *
 *                       | `/connect` (6)          | `/login` (8)
 *   --------------------|-------------------------|---------------------------
 *   Space               | 32^6 ≈ 2^30             | 32^8 ≈ 2^40
 *   A correct guess gets| your account linked to   | **that stranger's account**
 *                       | a stranger's WhatsApp    |
 *
 * 2^40 is about a million times larger than 2^30, and the reason it has to be
 * is that the code is **not really a second factor**. It is submitted alongside
 * a phone number or an email address — semi-public values an attacker plausibly
 * already has — so the code has to stand on its own. At 2^40 it does, and the
 * per-identifier attempt ceiling goes back to being a backstop rather than the
 * entire margin.
 *
 * ── A HAPPY CONSEQUENCE: THE TWO CODES ARE NON-INTERCHANGEABLE ───────────────
 * Different lengths mean a connection code physically cannot be submitted as a
 * login code, and vice versa. A user who pastes the wrong one gets a clean
 * rejection instead of a confusing partial match, and no code can ever be
 * replayed across the two features. That is a property of the design rather
 * than of a check somebody has to remember to write.
 *
 * Pure — no Redis, no Express.
 */

export const LOGIN_CODE_LENGTH = 8;

/** Exported for the tests and for validator-level shape checks. */
export const LOGIN_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** A login code: the shared generator at this feature's length. */
export function generateLoginCode(): string {
  return generateCode(LOGIN_CODE_LENGTH);
}

/**
 * The shared normaliser, under this module's own name.
 *
 * A binding rather than a copy. It runs on the mint side and the redeem side,
 * so the stored key and the looked-up key come from one function and cannot
 * drift — and because the alphabet excludes every glyph it rewrites, it can
 * only ever rescue a mistyping user and can never collapse two live codes.
 */
export const normalizeLoginCode = normalizeCode;

/** Whether a normalized string could be a login code at all. Cheap pre-Redis reject. */
export function isWellFormedLoginCode(normalized: string): boolean {
  return isWellFormedCode(normalized, LOGIN_CODE_LENGTH);
}
