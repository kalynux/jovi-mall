import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Language } from '../../../core/constants/languages';
import { normalizePhoneNumber } from '../../../core/validation/phone';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { META_LANGUAGE_CODE } from '../../notifications/catalog/notification-i18n';
import { PHONE_VERIFICATION_CONFIG, OTP_LIMITS } from '../config/phone-verification.config';
import { generateOtp, judgeOtp, mayResend } from '../domain/otp';
import { clearOtp, putOtp, readOtp, recordFailedAttempt, OtpRecord } from './otp.store';
import { otpMessage, otpFallbackTemplateParams } from '../domain/otp-copy';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';

export interface VerificationTarget {
    subject: string;
    phone: string;
    intent: OtpRecord['intent'];
    language: Language;
}

export interface SendResult {
    /** Masked, never the full number — the caller already knows it, a log line should not. */
    phoneMasked: string;
    expiresAt: Date;
    /** Which side of the 24-hour window this went out on. Useful in support, cheap to report. */
    delivery: 'text' | 'template';
}

/**
 * WhatsApp phone verification for accounts that do NOT arrive through the bot.
 *
 * ── Why this exists beside a stronger proof ──────────────────────────────────
 *
 * `ContactChangeService` proves a phone by requiring an existing WhatsApp **connection** on
 * that number: a message actually arrived from it, which beats any code the platform sends
 * itself. That is the customer path and it stays.
 *
 * Vendors, agencies, agents and administrators sign up on a dashboard. They may never message
 * the platform, so there is no connection to check and — before this — their number could not
 * be verified at all, which is why `phone_verified` sits `false` on role entities that have
 * been trading for months.
 *
 * ── The two delivery paths, and why the second can be CLOSED ─────────────────
 *
 * Inside Meta's 24-hour service window a free-form message is allowed, so the code goes out as
 * styled text. Outside it, only an approved template may be sent — and if
 * `PHONE_VERIFY_TEMPLATE_NAME` names a template that does not exist on the WABA, the send
 * fails. It is reported as `MAIL`-style loudness rather than swallowed: a verification code
 * that silently never arrives is indistinguishable, to the person waiting, from a platform
 * that is ignoring them.
 *
 * ── The out-of-window path has TWO templates, and the second is a policy trade ───
 *
 * `deliver()` tries the AUTHENTICATION template **first, always**, and falls back to a UTILITY
 * template carrying the same code.
 *
 * ✅ **THE PRIMARY PATH IS LIVE. Measured 2026-09-15: `wi_mall_phone_verification` is APPROVED
 * on the WABA in `en` and `fr`** (`4426347317613316` / `1393590468966788`), so an out-of-window
 * send takes the first branch and the fallback is never reached.
 *
 * ⚠ **Most of the surrounding documentation was written one day earlier, when it was not.** On
 * 2026-09-14 the owning business was `business_verification_status: "rejected"`, Meta gates the
 * AUTHENTICATION category behind that verification, and the template could not be created at
 * all (code 10 / subcode 2388185) while UTILITY templates created fine on the same credential.
 * The business reached `verified` on 2026-09-15 and Meta approved both languages within seconds
 * of submission. **No code changed for that to happen** — the order never changed — which is
 * exactly what the old comments promised would be true, and is worth recording because it is
 * the rare case where the documented recovery actually behaved as documented.
 *
 * ⛔ **The UTILITY fallback is still unsendable, and that did NOT change with the
 * verification.** Meta rejected it at review (`INCORRECT_CATEGORY`, both languages) and again
 * synchronously under `allow_category_change: true`; that verdict is about OTP **content**, not
 * about the business. It is now dead weight rather than a second route — see `otp-copy.ts` for
 * why it is kept as a lever and why rewording it is not the answer.
 *
 * ⚠ **In-window delivery is unaffected and works**, because free-form text needs no template.
 *
 * ⚠ **The swap is invisible to callers by design.** `SendResult.delivery` stays `'template'`
 * for either template, so no client can come to depend on which one went out, and resolving
 * the verification later does not alter a single response body. The distinction lives in the
 * server log, which is where an operator — not a frontend — needs it.
 *
 * See `scripts/generate-whatsapp-templates.ts` and `api-doc/notifications/whatsapp-templates.md`.
 */
export class PhoneVerificationService {
    constructor(private readonly window: WhatsappService = new WhatsappService()) {}

    /**
     * Mint and send a code.
     *
     * ⚠ **The cooldown is checked BEFORE the code is generated**, so a refused resend does not
     * invalidate the code already in the person's hand. Generating first and then refusing is
     * the obvious ordering and it is hostile: a double-tap on "resend" would destroy the code
     * they are halfway through typing.
     */
    async send(target: VerificationTarget): Promise<SendResult> {
        const phone = normalizePhoneNumber(target.phone);
        if (!phone) {
            throw createAppError(
                ERROR_CODES.PHONE_VERIFICATION_NO_TARGET,
                422,
                'No usable phone number to verify on this account',
            );
        }

        const now = new Date();
        const existing = await readOtp(target.subject);
        const verdict = mayResend(existing?.sentAt ?? null, now, OTP_LIMITS);
        if (!verdict.allowed) {
            throw createAppError(
                ERROR_CODES.PHONE_VERIFICATION_RESEND_TOO_SOON,
                429,
                `Another code can be requested in ${verdict.retryAfterSeconds}s`,
                { retryAfterSeconds: verdict.retryAfterSeconds },
            );
        }

        const code = generateOtp();
        const expiresAt = new Date(now.getTime() + OTP_LIMITS.ttlSeconds * 1000);

        const delivery = await this.deliver(phone, code, target.language);

        /**
         * ⚠ **Stored only AFTER a successful send.** Storing first would start the cooldown on
         * a code nobody received, locking the person out of retrying for a minute because of a
         * failure that was ours.
         */
        await putOtp(target.subject, {
            phone, code, attempts: 0, sentAt: now, expiresAt, intent: target.intent,
        });

        return { phoneMasked: maskPhone(phone), expiresAt, delivery };
    }

    /**
     * Judge a submitted code and, on success, spend it.
     *
     * Returns the proved number and what it was for; applying the consequence — completing a
     * pending change, or stamping `phone_verified` — is the CALLER's job. That split keeps this
     * service free of the user model and stops it growing a second copy of the change
     * mechanics that `ContactChangeService.applyPhoneChange` already owns.
     */
    async confirm(subject: string, supplied: string): Promise<{ phone: string; intent: OtpRecord['intent'] }> {
        const record = await readOtp(subject);
        if (!record) {
            throw createAppError(
                ERROR_CODES.PHONE_VERIFICATION_CODE_EXPIRED,
                422,
                'No verification is in progress. Request a new code.',
            );
        }

        const outcome = judgeOtp(record, supplied, new Date(), OTP_LIMITS);

        switch (outcome.outcome) {
            case 'ok':
                // Spent, immediately and unconditionally — a code that verified once must not
                // verify twice.
                await clearOtp(subject);
                return { phone: record.phone, intent: record.intent };

            case 'expired':
                await clearOtp(subject);
                throw createAppError(
                    ERROR_CODES.PHONE_VERIFICATION_CODE_EXPIRED,
                    422,
                    'That code has expired. Request a new one.',
                );

            case 'exhausted':
                await clearOtp(subject);
                throw createAppError(
                    ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS,
                    429,
                    'Too many incorrect codes. Request a new one.',
                );

            case 'mismatch':
                await recordFailedAttempt(subject, record);
                /**
                 * `attemptsLeft` is disclosed deliberately. It tells the holder of the real code
                 * that they mistyped and how much room they have, and it tells an attacker
                 * something they could measure anyway by counting their own requests. The
                 * secret is the code, not the counter.
                 */
                throw createAppError(
                    ERROR_CODES.PHONE_VERIFICATION_CODE_INVALID,
                    422,
                    'That code is not correct.',
                    { attemptsLeft: outcome.attemptsLeft },
                );
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async deliver(phone: string, code: string, lang: Language): Promise<'text' | 'template'> {
        // Meta addresses by bare digits; `login_phone` is strict E.164. The same mismatch that
        // made `identity-resolver.service.ts` match nothing for every user.
        const waPhoneId = phone.replace(/^\+/, '');
        const withinWindow = await this.window.canSendFreeMessage(waPhoneId);

        if (withinWindow) {
            const result = await getWhatsAppMessagingService().send(
                WaServiceMessage.text({ to: phone, body: otpMessage(code, lang, OTP_LIMITS.ttlSeconds) }),
            );
            if (!result?.success) {
                throw createAppError(
                    ERROR_CODES.PHONE_VERIFICATION_DELIVERY_FAILED,
                    502,
                    'The verification code could not be delivered over WhatsApp',
                );
            }
            return 'text';
        }

        /**
         * ⚠ **AUTHENTICATION IS ALWAYS TRIED FIRST, and the order is the whole design.**
         *
         * An AUTHENTICATION template takes the code in the BODY and again in the copy-code
         * BUTTON. Meta requires both; sending only the body renders a button that copies
         * nothing.
         *
         * ⚠ **`sub_type: 'url'` on a COPY_CODE button is CORRECT and looks like a bug.** It was
         * read back off the approved template on 2026-09-15 rather than guessed: Meta compiles
         * `{ type: 'OTP', otp_type: 'COPY_CODE' }` down to a plain **URL** button whose href is
         * `https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=10&code=otp{{1}}`.
         * So the button really does carry one positional URL parameter at index 0, and the
         * tempting "fix" to `sub_type: 'copy_code'` — which is the coupon-code button on
         * MARKETING/UTILITY templates — would break a working send.
         */
        const primary = PHONE_VERIFICATION_CONFIG.OTP_TEMPLATE_NAME.trim();
        if (primary && await this.trySendTemplate(phone, lang, primary, [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] },
        ])) {
            return 'template';
        }

        /**
         * ── The UTILITY fallback ─────────────────────────────────────────────
         *
         * Reached only when the AUTHENTICATION send above failed — which, since 2026-09-15, it
         * no longer does in the ordinary case: that template is APPROVED and this branch is
         * dead on the happy path.
         *
         * ⛔ **And when it IS reached it will also fail**, because the template it names was
         * rejected by Meta and no longer exists on the WABA. That is accepted: the branch costs
         * one failing call on a path that has already failed, and the 502 below reports both
         * names. See `otp-copy.ts` for why it is kept as a lever rather than deleted, and why
         * rewording it is not the answer.
         *
         * ⚠ **This carries NO copy-code button and NO Meta-rendered security or expiry line** —
         * a UTILITY template gets none of the three — so its body says all of it itself, and
         * takes two parameters where the AUTHENTICATION one takes the code twice.
         *
         * ⚠ **A failed-looking primary that actually delivered sends the person a SECOND
         * message.** That is accepted deliberately: it is the *same* code, not a new one, so
         * the worst case is a duplicate rather than a code that no longer works — which is what
         * minting a fresh one here would produce.
         */
        const fallback = PHONE_VERIFICATION_CONFIG.OTP_TEMPLATE_FALLBACK_NAME.trim();
        if (fallback) {
            const parameters = otpFallbackTemplateParams(code, OTP_LIMITS.ttlSeconds)
                .map(text => ({ type: 'text' as const, text }));

            if (await this.trySendTemplate(phone, lang, fallback, [{ type: 'body', parameters }])) {
                console.warn(
                    `[PhoneVerification] '${primary}' could not be sent; delivered through the `
                    + `UTILITY fallback '${fallback}'. The AUTHENTICATION template is APPROVED on `
                    + 'this WABA, so reaching this line means a SEND failure (rate limit, quality '
                    + 'block, token) rather than a missing template — investigate the primary.',
                );
                return 'template';
            }
        }

        throw createAppError(
            ERROR_CODES.PHONE_VERIFICATION_DELIVERY_FAILED,
            502,
            `The verification code could not be delivered: neither '${primary}' nor the fallback `
            + `'${fallback || '(none configured)'}' could be sent, and a free-form message is `
            + 'refused outside the 24-hour window',
        );
    }

    /**
     * One template send, reduced to did-it-go-out.
     *
     * ⚠ **It swallows the throw on purpose, and only here.** The messaging service reports some
     * failures as `success: false` and raises others, and a fallback that only handles the first
     * kind would not fire for the very error this exists for — a missing template, which arrives
     * as a raised Meta error. The refusal still reaches the caller: every path returning `false`
     * ends at the 502 above, so nothing is swallowed *silently*, only re-shaped into a decision
     * about whether to try the next template.
     */
    private async trySendTemplate(
        phone: string,
        lang: Language,
        name: string,
        components: TemplateComponent[],
    ): Promise<boolean> {
        try {
            const result = await getWhatsAppMessagingService().send({
                to: phone,
                type: 'template',
                message: { type: 'template', name, language: META_LANGUAGE_CODE[lang], components },
                meta: {},
            });
            if (!result?.success) {
                console.warn(`[PhoneVerification] template '${name}' [${META_LANGUAGE_CODE[lang]}] was refused`);
            }
            return Boolean(result?.success);
        } catch (error) {
            console.warn(
                `[PhoneVerification] template '${name}' [${META_LANGUAGE_CODE[lang]}] raised: `
                + `${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
    }
}

/** `+237600123456` → `+237•••••3456`. Enough to recognise, not enough to dial. */
function maskPhone(phone: string): string {
    if (phone.length <= 8) return phone;
    return `${phone.slice(0, 4)}${'•'.repeat(Math.max(0, phone.length - 8))}${phone.slice(-4)}`;
}

export const phoneVerificationService = new PhoneVerificationService();
