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
     *
     * ⚠ **Changing this does NOT change what the out-of-window WhatsApp message says.** The
     * approved AUTHENTICATION template carries Meta's own footer ("Expires in 10 minutes.") and
     * a copy-code button whose URL embeds `code_expiration_minutes=10`, both **frozen inside the
     * approved template** — the send passes only the code. So lowering this to, say, 300 gives a
     * message that promises ten minutes over a code that dies in five, with no error anywhere.
     * The generator derives the submitted value from this constant and
     * `test:phone-verification` § 6c pins the two together, so the drift is caught at
     * generation — but **an already-approved template can only be corrected by resubmitting it
     * under a new name**, exactly like the button host. Treat this as a Meta-side value that
     * happens to live here, not a free local knob.
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
     *
     * ✅ **APPROVED on the live WABA since 2026-09-15**, in `en` and `fr`
     * (`4426347317613316` / `1393590468966788`), once the owning business reached
     * `business_verification_status: "verified"`. It had been uncreatable for a day — code 10 /
     * subcode 2388185 — which is the state most of the surrounding documentation was written in.
     */
    OTP_TEMPLATE_NAME: process.env.PHONE_VERIFY_TEMPLATE_NAME || 'wi_mall_phone_verification',

    /**
     * The **UTILITY fallback** template, tried only when the AUTHENTICATION send above fails.
     *
     * ⚠ **Its existence does not soften the rule in the entry above — it answers a different
     * problem.** The rule is that OTP content *belongs* in an AUTHENTICATION template, and that
     * is still true and still the first thing attempted. This exists because the category can be
     * **unreachable**: Meta gates it behind business verification, and on 2026-09-14 this WABA's
     * owning business was `business_verification_status: "rejected"`, so the AUTHENTICATION
     * template could not be created at all (code 10) while UTILITY ones created fine on the same
     * credential. The choice then was a closed out-of-window path or this.
     *
     * ✅ **That is over. Measured 2026-09-15: the business is `verified` and
     * `wi_mall_phone_verification` is APPROVED in both languages**, so the primary path above
     * works and this is never reached on an ordinary send.
     *
     * ⛔ **BUT THE DEFAULT NAMED HERE IS UNSENDABLE AND ALWAYS WILL BE.** Meta rejected that
     * template at review (`INCORRECT_CATEGORY`, both languages) and again *synchronously* under
     * `allow_category_change: true`. That verdict is about OTP **content**, not about the
     * business, so the verification being resolved does not revive it — and the rejected rows
     * have since vanished from the WABA, so the name now resolves to nothing at all.
     *
     * The default is kept rather than emptied because it costs exactly one failing API call on a
     * path that is itself already failing, and because emptying it would delete the only record
     * of which name was tried. **An operator who wants the second call gone sets
     * `PHONE_VERIFY_FALLBACK_TEMPLATE_NAME=` (empty) — that is supported and changes no
     * behaviour that works today.**
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
