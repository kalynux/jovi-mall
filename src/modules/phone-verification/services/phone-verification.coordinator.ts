import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Language, DEFAULT_LANGUAGE } from '../../../core/constants/languages';
import { contactChangeService, ContactChangeActor } from '../../users/services/contact-change.service';
import { phoneVerificationService } from './phone-verification.service';
import { readOtp } from './otp.store';
import { platformSubject } from '../domain/subject';

/**
 * Joins the OTP to the account.
 *
 * ── Why this is a third file rather than two ─────────────────────────────────
 *
 * `PhoneVerificationService` owns the CODE — minting, delivery, judging — and knows nothing
 * about users. `ContactChangeService` owns the CONSEQUENCE — swapping the identifier, stamping
 * `phone_verified`, the audit row — and knows nothing about codes. Neither should import the
 * other's concerns: a code service that writes user documents grows a second copy of the
 * change mechanics, and a contact service that mints credentials inherits a Redis dependency
 * and a retry policy it has no use for.
 *
 * This file is the only place that knows both, and it is deliberately thin enough to read in
 * one sitting.
 */

export interface VerificationState {
    phoneMasked: string | null;
    /** True when a change is in flight, so the code proves the NEW number rather than the old. */
    completesPendingChange: boolean;
    pending: boolean;
    expiresAt: Date | null;
}

export class PhoneVerificationCoordinator {
    async request(actor: ContactChangeActor): Promise<{ phoneMasked: string; expiresAt: Date; delivery: 'text' | 'template' }> {
        const target = await contactChangeService.resolveVerificationTarget(actor.userId);

        if (!target.phone) {
            /**
             * An account with no number at all. Reported as its own refusal rather than a
             * generic 422, because the remedy is a different endpoint — `PATCH /api/me/phone`
             * to set one — and a caller cannot infer that from "invalid request".
             */
            throw createAppError(
                ERROR_CODES.PHONE_VERIFICATION_NO_TARGET,
                422,
                'There is no phone number on this account to verify. Set one first.',
            );
        }

        return await phoneVerificationService.send({
            subject: platformSubject(actor.userId),
            phone: target.phone,
            intent: target.completePendingChange ? 'complete_change' : 'verify_current',
            language: languageOf(actor),
        });
    }

    async confirm(actor: ContactChangeActor, code: string): Promise<{ phone: string; changed: boolean }> {
        const proved = await phoneVerificationService.confirm(platformSubject(actor.userId), code);

        /**
         * ⚠ **The intent comes from the RECORD, not from the account's state right now.**
         *
         * A pending change can be cancelled between the code being sent and typed. Re-deriving
         * the intent here would then apply the wrong outcome — stamping the OLD number as
         * verified using a code that proved the NEW one. Storing the intent with the code binds
         * the proof to what it was for.
         */
        return await contactChangeService.applyProvenPhone(actor, proved.phone, {
            completePendingChange: proved.intent === 'complete_change',
        });
    }

    async describe(actor: ContactChangeActor): Promise<VerificationState> {
        const target = await contactChangeService.resolveVerificationTarget(actor.userId);
        const record = await readOtp(platformSubject(actor.userId));
        const live = record !== null && record.expiresAt.getTime() > Date.now();

        return {
            phoneMasked: target.phone ? mask(target.phone) : null,
            completesPendingChange: target.completePendingChange,
            pending: live,
            expiresAt: live ? record!.expiresAt : null,
        };
    }
}

/**
 * ⚠ The actor carries no language today, so this is the platform default.
 *
 * Stated rather than silently defaulted: the role entity holds `preferred_language` and reading
 * it would mean a query on the request path for a single string. When the actor grows a
 * language — `requireAuth` already loads the role entity — take it from there and delete this.
 */
function languageOf(_actor: ContactChangeActor): Language {
    return DEFAULT_LANGUAGE;
}

function mask(phone: string): string {
    if (phone.length <= 8) return phone;
    return `${phone.slice(0, 4)}${'•'.repeat(Math.max(0, phone.length - 8))}${phone.slice(-4)}`;
}

export const phoneVerificationCoordinator = new PhoneVerificationCoordinator();
