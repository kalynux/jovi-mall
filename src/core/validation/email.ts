import { z } from 'zod';
import { clearable } from './zod.helpers';

/**
 * Email addresses - one definition, everywhere.
 *
 * Every endpoint, DTO, service and background job that accepts an email goes
 * through the schemas below. They replace a mixture of `z.string().email()`
 * (Zod's own check, which accepts `a@b` - no dot, no TLD) and, in a few places,
 * no check at all.
 *
 * What "RFC-compliant" means here, precisely, because the RFC is broader than
 * anything a real mail system will deliver to:
 *
 *  - The local part is validated as an RFC 5322 **dot-atom**: the permitted
 *    atext characters, separated by single dots, never leading or trailing.
 *  - RFC 5321 quoted local parts (`"john doe"@example.com`) are **rejected**.
 *    They are legal on paper and unusable in practice - most providers refuse
 *    them, and accepting one here would put a string into the database that
 *    every downstream system then mangles differently.
 *  - The domain must be a real dotted name with an alphabetic TLD. Bare hosts
 *    (`root@localhost`), IP-literal domains (`user@[192.168.0.1]`) and trailing
 *    dots are rejected: this platform mails customers, not hosts on its LAN.
 *  - RFC 5321 length limits are enforced - 64 octets for the local part, 254
 *    for the whole address. A longer address cannot be delivered, so accepting
 *    it would only defer the failure to the mail provider.
 *
 * Normalisation is trim + lowercase, matching what the Mongoose schemas already
 * do (`login_email`, and the per-role `email` fields all carry
 * `lowercase: true`). Lowercasing the local part is technically a liberty - the
 * RFC lets it be case-sensitive - but it is the platform's existing standard
 * and the thing that makes "already registered" lookups work; splitting the
 * rule between the schema and the model is what we are removing.
 */

/**
 * Dot-atom local part @ dotted domain with an alphabetic TLD.
 *
 * Length bounds are deliberately NOT in the pattern (a regex that also counts
 * gets unreadable) - `isEmailAddress` applies them.
 */
export const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** RFC 5321 section 4.5.3.1: the whole address, in octets. */
export const MAX_EMAIL_LENGTH = 254;

/** RFC 5321 section 4.5.3.1: the local part, in octets. */
export const MAX_EMAIL_LOCAL_PART_LENGTH = 64;

export const EMAIL_FORMAT_MESSAGE = 'Must be a valid email address (e.g. name@example.com)';

/**
 * Canonical form of an email address: trimmed and lowercased.
 *
 * Safe to call on any string - it never rejects. Use `isEmailAddress` (or a
 * schema below) to decide whether the result is acceptable.
 */
export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether an ALREADY-NORMALISED value is a well-formed, deliverable-shaped address. */
export function isEmailAddress(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  // Split on the LAST `@`: the local part may legally contain one, the domain
  // may not, so this is the only separator reading that cannot be fooled.
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator > MAX_EMAIL_LOCAL_PART_LENGTH) return false;
  return EMAIL_PATTERN.test(value);
}

/**
 * Normalise and validate in one step, for the call sites Zod does not cover -
 * outbound mail, background jobs, repository lookups. Returns `null` when the
 * value is unusable, so a best-effort path can skip and a critical path can
 * raise, each without re-deriving the rule.
 */
export function toEmailAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeEmailAddress(value);
  return isEmailAddress(normalized) ? normalized : null;
}

/**
 * A required email address. Output is normalised - mappers, services and
 * repositories downstream receive the canonical value, never the raw input.
 */
export const EmailAddressSchema = z
  .string({
    required_error: 'Email address is required',
    invalid_type_error: 'Email address must be a string',
  })
  .transform(normalizeEmailAddress)
  .refine(isEmailAddress, { message: EMAIL_FORMAT_MESSAGE });

/**
 * An optional email address: absent is fine, present must be valid.
 *
 * Optionality is a property of the *field*, not of the format - an address that
 * is sent is held to exactly the same rule as a required one.
 */
export const OptionalEmailAddressSchema = EmailAddressSchema.optional();

/**
 * A clearable email address for PATCH bodies - `''`/`null` clears it, anything
 * else must be a valid address. See `clearable()` for the clear semantics.
 */
export const ClearableEmailAddressSchema = clearable(EmailAddressSchema);
