import { createHash, randomInt, timingSafeEqual } from 'crypto';

/**
 * The OTP itself — generation, comparison, and the decisions that bound abuse.
 *
 * PURE: no clock of its own, no I/O, no config read. Every function takes `now` and its limits
 * as arguments, which is what lets the whole policy table be asserted without Redis and without
 * waiting ten minutes for an expiry.
 *
 * ── Why an OTP exists here at all, when a stronger proof already does ────────
 *
 * `ContactChangeService` proves control of a phone by requiring an existing **WhatsApp
 * connection** on that number — a message actually arrived from it, which is strictly stronger
 * evidence than a code the platform itself just sent. That remains the customer path and is not
 * being replaced.
 *
 * It cannot serve vendors, agencies, agents or administrators, because they do not register
 * through the bot: they sign up on a dashboard and may never message the platform at all, so
 * there is no connection to check and their number can never be verified. The OTP is the path
 * for an account whose phone the platform has no other way to reach.
 */

/**
 * Six digits.
 *
 * ⚠ Not because six is secure — 10^6 is trivially brute-forcible — but because the security
 * here is the ATTEMPT LIMIT, not the entropy, and six digits is what a person will retype off a
 * WhatsApp message without error. Lengthening the code to compensate for a missing attempt
 * limit is the classic wrong trade: it degrades the common case and barely moves the attack.
 *
 * Digits only, so it can be typed on a phone keypad and so Meta's AUTHENTICATION template
 * (which renders a copy-code button) accepts it.
 */
export const OTP_LENGTH = 6;

/**
 * `randomInt` from `crypto`, never `Math.random()`.
 *
 * `Math.random()` is seeded per process and its output is predictable from previous draws — an
 * attacker who can request codes for their own account could predict somebody else's. The
 * rejection-sampling `randomInt` is also unbiased, which `Math.floor(Math.random() * 10)` is
 * not once you care.
 */
export function generateOtp(): string {
    let code = '';
    for (let i = 0; i < OTP_LENGTH; i++) code += String(randomInt(0, 10));
    return code;
}

/** Strip anything a person might paste around the digits — spaces, dashes, a stray zero-width. */
export function normalizeOtp(input: string): string {
    return input.replace(/[^0-9]/g, '');
}

/**
 * Constant-time comparison.
 *
 * ⚠ `a === b` on a secret leaks its prefix through timing. The window is small over a network
 * and it is free to close, and — the part that actually matters — a `===` here is invisible in
 * review once somebody "simplifies" it. Lengths are compared first because `timingSafeEqual`
 * throws on a mismatch, and length is not a secret.
 */
export function otpMatches(supplied: string, expected: string): boolean {
    const a = Buffer.from(normalizeOtp(supplied), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * The Redis key component for an account.
 *
 * ⚠ **Hashed, and that is a rule this codebase already applies to credential stores.**
 * `GET /system/cache/keys` lists key NAMES on the operations surface, so a raw user id or phone
 * number in a key is personal data in a listing that is not otherwise a disclosure surface —
 * the reasoning `messaging-login`'s `digestForKey` states. Values are not hashed, because that
 * endpoint offers no value read at all.
 */
export function digestForKey(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export interface OtpLimits {
    /** How long a code stays redeemable. */
    ttlSeconds: number;
    /** Wrong guesses before the record is destroyed and a new code must be requested. */
    maxAttempts: number;
    /** Minimum gap between sends, to bound message cost and nuisance. */
    resendCooldownSeconds: number;
}

export type ResendVerdict =
    | { allowed: true }
    | { allowed: false; retryAfterSeconds: number };

/**
 * May another code be sent?
 *
 * ⚠ The cooldown is keyed on the ACCOUNT, deliberately, not on the target number. Keying it on
 * the number would let one account walk a list of strangers' phones at full speed, sending each
 * a WhatsApp message that costs real money and that the recipient reads as an unsolicited
 * message from this platform. An account-scoped gate bounds the total regardless of how many
 * numbers are tried.
 */
export function mayResend(lastSentAt: Date | null, now: Date, limits: OtpLimits): ResendVerdict {
    if (!lastSentAt) return { allowed: true };
    const elapsed = (now.getTime() - lastSentAt.getTime()) / 1000;
    if (elapsed >= limits.resendCooldownSeconds) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.ceil(limits.resendCooldownSeconds - elapsed) };
}

export type VerifyVerdict =
    | { outcome: 'ok' }
    | { outcome: 'expired' }
    | { outcome: 'mismatch'; attemptsLeft: number }
    | { outcome: 'exhausted' };

/**
 * Judge one submitted code. **Pure — it neither reads nor writes the store.**
 *
 * The caller applies the consequence (destroy the record, increment the counter), which keeps
 * the whole decision table testable against a plain object and stops the policy drifting into
 * the Redis layer where it cannot be read in one place.
 *
 * ⚠ `exhausted` is returned when the attempt BEFORE this one used the last try, and it is a
 * distinct outcome from `mismatch` with zero left: the first means "stop asking, request a new
 * code", the second is the last wrong guess. Collapsing them leaves a client looping on a
 * record that can never succeed.
 */
export function judgeOtp(
    record: { code: string; attempts: number; expiresAt: Date },
    supplied: string,
    now: Date,
    limits: OtpLimits,
): VerifyVerdict {
    if (now.getTime() >= record.expiresAt.getTime()) return { outcome: 'expired' };
    if (record.attempts >= limits.maxAttempts) return { outcome: 'exhausted' };
    if (otpMatches(supplied, record.code)) return { outcome: 'ok' };

    const attemptsLeft = Math.max(0, limits.maxAttempts - (record.attempts + 1));
    return { outcome: 'mismatch', attemptsLeft };
}
