import { isEmailAddress, normalizeEmailAddress } from '../../../core/validation/email';
import { isE164, normalizePhoneNumber } from '../../../core/validation/phone';

/**
 * The phone-or-email a customer types beside their sign-in code.
 *
 * The same `@` discrimination and the same normalisers `POST /auth/login` uses
 * (`LoginIdentifierSchema` in `auth.schemas.ts`) — deliberately, so the value
 * that is validated is the value that is looked up. `login_email` is stored
 * lowercased and `login_phone` in strict E.164, so `John@Example.COM` or
 * `+237 670 00 00 00` would otherwise miss a row that exists.
 *
 * Pure — no repositories, no Redis — so both the validator and the service can
 * use it without either importing the other.
 */

/**
 * Canonical form. Safe to call on anything; it never rejects.
 *
 * ⚠ This is also what the ATTEMPT COUNTER keys on, and that is the less obvious
 * reason it matters. Un-normalised, `+237 670 00 00 00` and `+237670000000`
 * hash to two different keys — so a guesser gets a fresh allowance for every
 * spelling of the same number, and the ceiling in §6 bounds nothing at all.
 */
export function normalizeLoginIdentifier(value: string): string {
  return value.includes('@') ? normalizeEmailAddress(value) : normalizePhoneNumber(value);
}

/** Whether an ALREADY-NORMALISED identifier is a usable phone number or email. */
export function isUsableLoginIdentifier(normalized: string): boolean {
  return normalized.includes('@') ? isEmailAddress(normalized) : isE164(normalized);
}
