/**
 * When a vendor, agency or agent account becomes `active` — the rule, in one place.
 *
 * ── The decision this encodes (owner, 2026-09-15) ────────────────────────────
 *
 * An account activates ITSELF once the fundamentals are proved: **a verified phone number
 * and a name**. Nothing else, and nobody else. Activation is no longer an administrator's
 * act.
 *
 * What an administrator still owns is a DIFFERENT question — *is this business who it says
 * it is* — and that lives on the KYC axis (`kyc_details.legit_verified` / `kyc.status`),
 * never on `status`. The two were conflated for agencies, where one admin endpoint wrote
 * both, and separating them is the point of this file.
 *
 * ⚠ **`status` and `verified` now answer different questions, and nothing may re-fuse them:**
 *
 *     status  — can this account operate at all?        (the account holder, by proving a phone)
 *     kyc     — has a human vetted this business?       (an administrator, by review)
 *
 * The consequence to hold on to: **`status === 'active'` no longer implies "vetted"**. Every
 * gate that used `active` as a proxy for administrative approval has to say what it actually
 * means. `CodEligibilityService` is the one that did, and it now tests both.
 *
 * ── Why the promotion is a FILTERED update and never a read-then-write ───────
 *
 * The filter carries the whole rule, so the evaluation and the write are one atomic
 * operation. Two properties fall out of that and both are load-bearing:
 *
 *   1. **Only `pending_verification` is ever promoted.** An `inactive` or `suspended`
 *      account that verifies a phone stays exactly where an administrator put it. Writing
 *      `status: 'active'` unconditionally would let a suspended account lift its own
 *      suspension by re-proving a number it already holds — the identical trap
 *      `VendorRepository.markEmailVerified` was rewritten to close.
 *   2. **No window between the check and the write**, so two concurrent proofs cannot both
 *      observe `pending_verification` and race.
 *
 * ── Why there is no backfill, and why none is needed ─────────────────────────
 *
 * Pre-production rule D-5 (2026-08-21) forbids data migrations, and this change needs none:
 * the population it would target is empty. `phone_verified` has been `false` on essentially
 * every role entity since the beginning — `PhoneVerificationService`'s own header says as
 * much — because the only path that could set it, the WhatsApp OTP, never delivered a code
 * (the service window was never recorded; see `bot-registration.service.ts`). So there are
 * no accounts sitting at `pending_verification` *with* a proved phone waiting to be swept
 * up. New proofs promote on the spot, and the administrative `PATCH .../status` remains for
 * anything that needs moving by hand.
 */

/** The only status a self-service promotion may move an account OUT of. */
export const ACTIVATION_ELIGIBLE_FROM = 'pending_verification';

/** The status it moves them to. */
export const ACTIVATION_TARGET = 'active';

/**
 * The Mongo filter fragment carrying the whole rule, for the three role collections.
 *
 * `nameField` differs by role — `display_name` on vendor and agency, `name` on agent — and
 * is passed rather than guessed, so a collection whose name column is spelled differently
 * cannot silently match the wrong key and promote on a field that is always absent.
 *
 * ⚠ **`$nin: [null, '']` rather than `$exists` or a truthiness test.** A name that was never
 * set is `null`; a name cleared through a PATCH is `''`. Both mean "no name", and `$exists`
 * is true for both.
 */
export function activationFilter(nameField: string): Record<string, unknown> {
    return {
        status: ACTIVATION_ELIGIBLE_FROM,
        phone_verified: true,
        [nameField]: { $nin: [null, ''] },
    };
}

/**
 * The same rule as a pure predicate, for callers that already hold the document — DTOs
 * explaining *why* an account is not active, and the tests that pin this file.
 *
 * ⚠ Deliberately does NOT consider the KYC verdict. An unvetted account is still an active
 * one; what it cannot do is the narrower set of things that require vetting.
 */
export function meetsActivationFundamentals(subject: {
    phoneVerified: boolean | null | undefined;
    name: string | null | undefined;
}): boolean {
    return subject.phoneVerified === true && typeof subject.name === 'string' && subject.name.trim() !== '';
}
