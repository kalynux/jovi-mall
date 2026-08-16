import { randomBytes } from 'crypto';

/**
 * A password nobody chooses, nobody is told, and nobody can guess.
 *
 * ── WHY A CUSTOMER GETS ONE ──────────────────────────────────────────────────
 * Customers are passwordless in practice: they sign in through `/login` on
 * WhatsApp or Telegram (`modules/messaging-login/`). But `User.password_hash` is
 * `required: true`, and it should stay that way — the column is what the
 * password-RESET flow replaces, so a customer who later wants a real password
 * has somewhere to put it, and every other role still depends on it.
 *
 * So the account is created with a random one that is hashed immediately and
 * never disclosed. The effect is a `password_hash` that satisfies the model and
 * that no credential in existence matches.
 *
 * ── THE ALTERNATIVE WAS WORSE ────────────────────────────────────────────────
 * Accepting a caller-supplied password for a customer registration would create
 * accounts whose password SOMEBODY ELSE CHOSE AND KNOWS — a storefront, an
 * integration, whoever posted the form. `RegisterSchema` therefore strips the
 * field for `role: 'customer'` rather than merely making it optional: an ignored
 * field cannot become a back door later because a call site started forwarding
 * it.
 *
 * ── THE RULES FOR THE RETURN VALUE ───────────────────────────────────────────
 * It must never be logged, returned in a response, or included in any DTO. Its
 * only legitimate destination is `bcrypt.hash`. `test:messaging-login` asserts
 * this file's output never reaches a DTO or a log line.
 *
 * ⚠ Consequence, accepted deliberately and documented in `api-doc/auth/`:
 * `POST /auth/login` will ALWAYS fail for a customer who has never run a
 * password reset. That is correct — there is no password to present — but it
 * means the storefront's sign-in form must route customers to the messaging
 * flow rather than showing them a password field that cannot work.
 */

/**
 * 32 bytes of entropy, rendered base64url as 43 ASCII characters.
 *
 * ⚠ **Comfortably under bcrypt's 72-BYTE input limit**, and that bound is why
 * the length is stated rather than left to taste: bcrypt silently TRUNCATES
 * beyond 72 bytes, so a longer generated password would not fail — it would just
 * quietly stop adding entropy, and nothing would say so. base64url is also
 * ASCII-only, so 43 characters is exactly 43 bytes with no multi-byte surprises.
 *
 * `randomBytes`, never `Math.random` and never a helper that derives from a
 * timestamp, an id or a counter. A predictable value here would be a password
 * every customer account shares the shape of.
 */
export const SYSTEM_PASSWORD_BYTES = 32;

export function generateSystemPassword(): string {
  return randomBytes(SYSTEM_PASSWORD_BYTES).toString('base64url');
}
