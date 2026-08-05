import { z } from 'zod';
import { clearable } from './zod.helpers';

/**
 * Phone numbers - one format, everywhere.
 *
 * E.164 is the ONLY shape this backend accepts, stores or hands to a provider:
 * a leading `+`, the country calling code, then the national number, digits
 * only. Every endpoint, DTO, service and background job goes through the
 * schemas below rather than growing its own `min(6).max(20)` - those length
 * bounds accepted `677123456` (whose country nobody knows), `+++`, and
 * `(0) 677-12-34-56`, and each call site drew the line somewhere different.
 *
 * Two decisions worth knowing before you loosen this:
 *
 *  - **A national number is rejected, not guessed.** There is no per-request
 *    "default country" to resolve `677123456` against - the platform serves
 *    several - so inferring one would silently mint a wrong number that only
 *    fails much later, at the WhatsApp/SMS provider. The client must send the
 *    country code.
 *  - **`00`-prefixed international dialling is rejected too.** `00237...` is a
 *    valid thing to *dial*, but it is not E.164, and accepting it would put two
 *    spellings of one number in the database, breaking the uniqueness lookups
 *    that `login_phone` depends on. The `+` is required.
 *
 * Normalisation strips only *visual* formatting (spaces, dashes, dots,
 * parentheses) - characters that carry no information and that keypads and
 * copy-paste add freely. Nothing that changes which number it is.
 */

/**
 * E.164: `+`, a country code that cannot start with 0, then digits.
 *
 * Total digit count is bounded at 15 by the standard. The lower bound of 7 is
 * the shortest real international number (e.g. Niue `+683 4002`) - it exists to
 * reject the *incomplete* (`+1`, `+237`), not to second-guess a numbering plan.
 * This validates FORMAT, not reachability: no offline check can tell you a
 * well-formed number is assigned to anyone.
 */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Visual separators a human or a keypad may add - they carry no information.
 * Deliberately ASCII-only in source: JavaScript's `\s` already covers the
 * no-break and narrow-no-break spaces that copy-paste from a contact card
 * tends to carry, so nothing here needs a literal non-ASCII glyph. Typographic
 * dashes are NOT stripped - a number containing an em-dash is malformed, not
 * merely decorated, and is better rejected than quietly repaired.
 */
const PHONE_FORMATTING_CHARACTERS = /[\s().-]/g;

export const PHONE_FORMAT_MESSAGE =
  'Phone number must be in international E.164 format, including the country code (e.g. +237670000000)';

/**
 * Canonical form of a phone number: formatting stripped, nothing else changed.
 *
 * Safe to call on any string - it never rejects. Use `isE164` (or a schema
 * below) to decide whether the result is acceptable.
 */
export function normalizePhoneNumber(value: string): string {
  return value.replace(PHONE_FORMATTING_CHARACTERS, '');
}

/** Whether an ALREADY-NORMALISED value is a well-formed E.164 number. */
export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

/**
 * Normalise and validate in one step, for the call sites Zod does not cover -
 * outbound providers, background jobs, repository lookups. Returns `null` when
 * the value is unusable, so a best-effort path can skip and a critical path can
 * raise, each without re-deriving the rule.
 */
export function toE164(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizePhoneNumber(value);
  return isE164(normalized) ? normalized : null;
}

/**
 * A required phone number. Output is normalised E.164 - mappers, services and
 * repositories downstream receive the canonical value, never the raw input.
 */
export const PhoneNumberSchema = z
  .string({
    required_error: 'Phone number is required',
    invalid_type_error: 'Phone number must be a string',
  })
  .transform(normalizePhoneNumber)
  .refine(isE164, { message: PHONE_FORMAT_MESSAGE });

/**
 * An optional phone number: absent is fine, present must be valid.
 *
 * Optionality is a property of the *field*, not of the format - a number that
 * is sent is held to exactly the same rule as a required one.
 */
export const OptionalPhoneNumberSchema = PhoneNumberSchema.optional();

/**
 * A clearable phone number for PATCH bodies - `''`/`null` clears it, anything
 * else must be valid E.164. See `clearable()` for the clear semantics.
 */
export const ClearablePhoneNumberSchema = clearable(PhoneNumberSchema);
