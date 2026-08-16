import { randomBytes } from 'crypto';

/**
 * The bot-minted, human-retyped code — and the shared primitives every one of
 * them is built from.
 *
 * ── TWO CODES LIVE ON THESE PRIMITIVES ───────────────────────────────────────
 * This file now serves two features, at two lengths:
 *
 *   `/connect` → 6 characters, 2^30 — binds a messaging identity to an account
 *   `/login`   → 8 characters, 2^40 — grants a customer SESSION
 *                (`modules/messaging-login/domain/login-code.ts`)
 *
 * The alphabet, the unbiased `byte & 31` sampling and the normaliser are shared
 * because they are the same problem — a person reading characters off a phone
 * screen and typing them somewhere else. Only the length differs, and it differs
 * because the blast radius does: guessing a connection code attaches a stranger's
 * WhatsApp to your account, guessing a login code IS the stranger's account.
 *
 * `generateCode` / `normalizeCode` / `isWellFormedCode` are the generic layer;
 * the `*ConnectionCode` names below are `/connect`'s thin bindings over them, so
 * this module's own call sites keep reading in their own vocabulary.
 *
 * ⚠ `modules/messaging-login/` imports the generic three from this FILE rather
 * than from `channel-connections/index.ts`, which is the one deliberate
 * exception to that barrel's "never import from a file inside" rule. The barrel
 * exists to keep `external_id`, the repository and the model private, and to stop
 * a service dragging an Express controller into its load graph — this file
 * imports `crypto` and nothing else, so reaching it directly keeps the login
 * domain layer genuinely pure. Importing the barrel instead would put Mongoose
 * and the Redis factory behind a function that draws random bytes.
 *
 * ── THE 6-CHARACTER CONNECTION CODE ──────────────────────────────────────────
 * The only thing that crosses between the messaging world and a platform account.
 *
 * A bot mints one on `/connect` and stores it against the *messaging identity*;
 * the authenticated user types it on the platform, which redeems it and binds
 * that identity to their account. The code therefore carries **no account
 * information** — it is a bearer secret for one identity, for ten minutes.
 *
 * ── ENTROPY, STATED PLAINLY ──────────────────────────────────────────────────
 * 32^6 = 1,073,741,824 ≈ 2^30. Six characters is a product requirement (a human
 * retypes it from a phone screen), and 2^30 is **not enough on its own** — it is
 * roughly a billion guesses, which an unthrottled attacker gets through. What
 * makes it safe is three guards in `services/connection-code.store.ts`, and all
 * three are load-bearing:
 *
 *   1. ONE live code per identity  — a second `/connect` revokes the first, so
 *                                    the guessable set never accumulates.
 *   2. Atomic single-use (GETDEL)  — a code cannot be redeemed twice.
 *   3. Per-account attempt limit   — bounds guesses per redeeming account, on
 *                                    top of the identity rate limiter.
 *
 * Removing any one of them makes the code length the whole defence, and it is
 * not strong enough to be. Do not "simplify" the store on the strength of the
 * code alone.
 *
 * ── ALPHABET ─────────────────────────────────────────────────────────────────
 * Crockford-style base32: the full alphabet minus I, L, O and U. Nobody has to
 * decide whether the character they are reading is a 1 or an I, and the set
 * cannot accidentally spell an offensive word (U is gone).
 *
 * This is a DELIBERATE local copy of `shipments/utils/tracking-number.generator.ts`'s
 * `SUFFIX_ALPHABET`, not an import. That constant is baked into
 * `TRACKING_NUMBER_PATTERN`, the public handle a customer quotes to support —
 * sharing it would mean a change to one silently changes the other, and the two
 * have no reason to move together. What IS reused is the technique and its
 * correctness argument: exactly 32 symbols, and 256 % 32 === 0, so masking a
 * random byte with `& 31` samples the alphabet with **no modulo bias**.
 *
 * `crypto.randomBytes`, never `Math.random`. Every character is drawn
 * independently: nothing derives from a counter, a timestamp or an account id,
 * so codes are never sequential and one code tells you nothing about the next.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_LENGTH = 6;

/** Exported for the tests and for validator-level shape checks. */
export const CONNECTION_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6}$/;

// ─── The generic layer ───────────────────────────────────────────────────────

/**
 * A cryptographically random, unbiased code of `length` characters.
 *
 * The length is a parameter rather than a constant because two features mint
 * these at two sizes (see the header). It is NOT a knob to tune: each caller
 * passes its own module-level constant, and lowering one is a security change
 * that belongs in that module's own reasoning, not here.
 *
 * Uniqueness is NOT this function's job — each store claims its candidate with
 * `SET … NX` and retries on collision, which is the only way to make the check
 * atomic. This is pure so it can be tested without Redis.
 */
export function generateCode(length: number): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    // 256 % 32 === 0, so masking with `& 31` samples the 32-symbol alphabet with
    // no modulo bias. This is the property that makes the whole scheme sound —
    // see the ALPHABET note above before changing either number.
    code += CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

/**
 * Whether an ALREADY-NORMALISED value could be a code of this length at all.
 *
 * Derived from `CODE_ALPHABET` rather than from a pattern, so the accepted set
 * and the generated set are provably the same one. (A `new RegExp` built per
 * length would also be a bare `RegExp` construction, which this codebase bans
 * outright — see `core/utils/regex.util`.)
 */
export function isWellFormedCode(normalized: string, length: number): boolean {
  if (normalized.length !== length) return false;
  for (const character of normalized) {
    if (!CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * Fold what a user typed onto what a bot generated.
 *
 * Uppercases, strips whitespace and hyphens (people group characters when
 * copying them off a screen), then resolves the ambiguous glyphs: O → 0,
 * I → 1, L → 1.
 *
 * Length-independent, so both codes share it unchanged.
 *
 * ── WHY THIS IS SAFE, AND WHY IT MUST RUN ON BOTH SIDES ──────────────────────
 * The alphabet EXCLUDES I, L and O, so a generated code can never contain one.
 * That makes normalization a pure rescue for a mistyping user: it can never
 * collapse two distinct generated codes onto the same value, because no
 * generated code has a character this function rewrites. `test:connections`
 * and `test:messaging-login` both assert the property directly — every
 * generated code is a fixed point of this function, at both lengths.
 *
 * It runs on the mint side too (each store normalises before claiming the key),
 * so the stored key and the looked-up key are produced by the same function and
 * cannot drift.
 */
export function normalizeCode(raw: string): string {
  return raw
    .replace(/[\s-]+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

// ─── `/connect`'s bindings ───────────────────────────────────────────────────

/** A connection code: `generateCode` at the length `/connect` uses. */
export function generateConnectionCode(): string {
  return generateCode(CODE_LENGTH);
}

/**
 * The shared normaliser, under this module's own name.
 *
 * A binding rather than a copy — one implementation, so the connection code and
 * the login code can never disagree about what a user typed.
 */
export const normalizeConnectionCode = normalizeCode;

/** Whether a normalized string could be a code at all. Cheap pre-Redis reject. */
export function isWellFormedConnectionCode(normalized: string): boolean {
  return isWellFormedCode(normalized, CODE_LENGTH);
}
