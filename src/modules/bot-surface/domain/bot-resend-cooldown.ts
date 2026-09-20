/**
 * How long a customer must wait before we send a confirmation link again — pure.
 *
 * ── WHY THIS IS A FILE RATHER THAN THREE LINES IN THE CONTROLLER ────────────
 * The controller it serves reaches `users/services`, which cannot be imported under bare
 * `ts-node` (those modules do work at import and never return), so anything left inside it can
 * only ever be checked by scanning it as text. The arithmetic here has two off-by-one traps
 * worth proving rather than reading:
 *
 *   - **a wait that rounds to zero.** `retryAfterSeconds: 0` tells a client to retry
 *     immediately, which is exactly what the refusal exists to prevent — and it is the
 *     ordinary result one millisecond before the cooldown ends.
 *   - **the boundary itself.** A cooldown that is `<=` rather than `<` refuses the request
 *     that arrives exactly on time, which is the one a well-behaved client sends after being
 *     told to wait `retryAfterSeconds`.
 *
 * The clock is a parameter for the same reason `applyOnboardingStep` takes one: the whole rule
 * is assertable without freezing time.
 */

/**
 * Two minutes.
 *
 * ⚠ **Measured from the PENDING BLOCK'S OWN `requested_at`**, not from anything this surface
 * stores. A cooldown held in memory resets when the process restarts, and one held per channel
 * does not exist for the customer's other channel — so asking again from Telegram instead of
 * WhatsApp would escape it. The durable record of when we last sent something is the only
 * honest clock.
 */
export const CONTACT_RESEND_COOLDOWN_SECONDS = 120;

/**
 * Seconds still to wait, or **0 when the link may be sent now**.
 *
 * Never returns a fraction and never returns a positive value below 1: a caller puts this
 * straight into `retryAfterSeconds`, where anything under a second is a promise that the next
 * attempt will succeed and a lie by up to one second.
 *
 * ⚠ **A `requestedAt` in the future returns the full cooldown rather than a negative wait.**
 * Clocks disagree — the value is written by whichever process served the change — and a
 * negative wait would sail through `> 0` checks as "may send" while reading as nonsense in a
 * log.
 */
export function resendWaitSeconds(
    requestedAt: Date,
    now: Date,
    cooldownSeconds: number = CONTACT_RESEND_COOLDOWN_SECONDS,
): number {
    const elapsed = (now.getTime() - requestedAt.getTime()) / 1000;

    if (!Number.isFinite(elapsed)) return cooldownSeconds;
    if (elapsed < 0) return cooldownSeconds;
    if (elapsed >= cooldownSeconds) return 0;

    return Math.max(1, Math.ceil(cooldownSeconds - elapsed));
}
