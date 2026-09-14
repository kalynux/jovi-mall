import { OtpLimits } from '../domain/otp';

/**
 * Every assumption the phone-verification flow depends on, as a value.
 *
 * Same shape and same rule as `modules/system/config/system.config.ts`: read through a frozen
 * object built at import time, never a literal in a rule and never a bare `process.env` read at
 * a call site.
 */

function intEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const PHONE_VERIFICATION_CONFIG = Object.freeze({
    /**
     * Ten minutes. Long enough to switch apps, read a WhatsApp message and type six digits;
     * short enough that a phone left unlocked on a desk is not a standing credential.
     */
    OTP_TTL_SECONDS: intEnv('PHONE_VERIFY_TTL_SECONDS', 600),

    /**
     * Five wrong guesses, then the record is destroyed.
     *
     * ⚠ **This number IS the security of a six-digit code**, not its length. Five attempts
     * against 10^6 is a 1-in-200,000 chance per issued code; raising it to 50 makes the code
     * 1-in-20,000, which is the kind of change that looks like a usability tweak and is not.
     */
    OTP_MAX_ATTEMPTS: intEnv('PHONE_VERIFY_MAX_ATTEMPTS', 5),

    /**
     * Sixty seconds between sends, per ACCOUNT.
     *
     * Bounds two different costs at once: an out-of-window send is a paid WhatsApp template
     * message, and every send is a notification a real person reads. See `mayResend` for why
     * this is account-scoped rather than number-scoped.
     */
    OTP_RESEND_COOLDOWN_SECONDS: intEnv('PHONE_VERIFY_RESEND_COOLDOWN_SECONDS', 60),

    /**
     * The Meta template used when the recipient is OUTSIDE the 24-hour service window.
     *
     * ⚠ It must be category **AUTHENTICATION**, not UTILITY. Meta treats authentication
     * templates differently — they may carry a copy-code button, they are exempt from some
     * marketing limits, and submitting an OTP body as UTILITY is a documented rejection reason.
     *
     * ⚠ **Unset means the out-of-window path is CLOSED, not that it falls back to free text.**
     * A free-form send outside the window is refused by Meta, so pretending otherwise would
     * turn a configuration gap into a silent non-delivery — the failure this whole session has
     * been finding. `describeConfiguration()` reports it.
     */
    OTP_TEMPLATE_NAME: process.env.PHONE_VERIFY_TEMPLATE_NAME || 'wi_mall_phone_verification',

    /**
     * The **UTILITY fallback** template, tried only when the AUTHENTICATION send above fails.
     *
     * ⚠ **Its existence does not soften the rule in the entry above — it answers a different
     * problem.** The rule is that OTP content *belongs* in an AUTHENTICATION template, and that
     * is still true and still the first thing attempted. This exists because the category can be
     * **unreachable**: Meta gates it behind business verification, and measured 2026-09-14 this
     * WABA's owning business is `business_verification_status: "rejected"`, so the
     * AUTHENTICATION template cannot be created at all (code 10) while UTILITY ones create fine
     * on the same credential. The choice was a closed out-of-window path or this.
     *
     * ⛔ **AND META REFUSED IT — `INCORRECT_CATEGORY`, both languages, 2026-09-14.** So this
     * setting currently names a REJECTED template and the fallback send fails too; the
     * out-of-window path is closed either way. It is left wired up because it costs one failing
     * API call, it is correct the moment an approvable template exists, and the alternative —
     * rewording OTP copy until Meta's classifier stops recognising it — is evasion rather than
     * engineering. `allow_category_change: true` was tried and rejected synchronously.
     *
     * ✅ Resolve the business verification and the AUTHENTICATION path resumes on its own, with
     * this never reached — no code change, no redeploy.
     *
     * ⚠ **Empty CLOSES the fallback rather than disabling the feature.** An unset value means
     * "this deployment does not want the UTILITY swap", and the out-of-window failure is then
     * reported exactly as it was before.
     */
    OTP_TEMPLATE_FALLBACK_NAME: process.env.PHONE_VERIFY_FALLBACK_TEMPLATE_NAME
        ?? 'wi_mall_phone_verification_utility',
});

export const OTP_LIMITS: OtpLimits = Object.freeze({
    ttlSeconds: PHONE_VERIFICATION_CONFIG.OTP_TTL_SECONDS,
    maxAttempts: PHONE_VERIFICATION_CONFIG.OTP_MAX_ATTEMPTS,
    resendCooldownSeconds: PHONE_VERIFICATION_CONFIG.OTP_RESEND_COOLDOWN_SECONDS,
});
