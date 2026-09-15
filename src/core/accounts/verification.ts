/**
 * "Has a human vetted this business?" — the KYC axis, read uniformly across the three
 * payable roles.
 *
 * ── Why this is separate from `activation.ts` ────────────────────────────────
 *
 * They are the two halves of the same 2026-09-15 decision and must never be re-fused.
 * `activation.ts` answers *may this account operate* — the holder's own question, settled by
 * proving a phone. This answers *has an administrator vetted it* — and it is the one that
 * gates cash and money leaving the platform.
 *
 * ⚠ **The three roles do NOT share a verdict vocabulary, and flattening them would lose
 * information an administrator needs.** Vendor and agency default to `pending`; an agent
 * defaults to `unverified` and reaches `pending` only once documents are actually submitted.
 * So on an agent the two words mean different things — "nothing submitted" versus "submitted,
 * awaiting review" — while on a vendor `pending` covers both. A reviewer deciding whether to
 * chase someone for documents needs that distinction, so each role's own word is carried
 * through rather than normalised away.
 *
 * `verified` is the only value any GATE may test. Everything else is for a human to read.
 */

/** The union of all three roles' verdicts. Not every role can produce every value. */
export type VerificationVerdict = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface OwnerVerification {
    /**
     * The only field a decision may branch on.
     *
     * ⚠ Deliberately NOT `verdict !== 'rejected'`. "Never reviewed" is not approval, and an
     * unreviewed account must be treated as unvetted, not as innocent-until-refused.
     */
    verified: boolean;
    /** The role's own word for where the review stands. For display and for humans. */
    verdict: VerificationVerdict;
}

const KNOWN_VERDICTS: readonly string[] = ['unverified', 'pending', 'verified', 'rejected'];

/**
 * Read a verdict off a role's KYC sub-document.
 *
 * Accepts the shape all three happen to share — a `status` string — and tolerates its
 * absence, because a projection that omits it and a document that predates it are both
 * "we do not know", which is not the same as "approved".
 *
 * ⚠ An unrecognised value reads as `unverified`, never as verified. A verdict this file has
 * not been taught about must fail closed: the cost of misreading a new status as approval is
 * money leaving the platform to an unvetted account.
 */
export function verificationOf(
    kyc: { status?: string | null } | null | undefined,
): OwnerVerification {
    const raw = typeof kyc?.status === 'string' ? kyc.status : null;
    const verdict = (raw && KNOWN_VERDICTS.includes(raw) ? raw : 'unverified') as VerificationVerdict;
    return { verified: verdict === 'verified', verdict };
}

/** What an unresolvable owner reads as — a deleted row is not a vetted one. */
export const UNKNOWN_VERIFICATION: OwnerVerification = Object.freeze({
    verified: false,
    verdict: 'unverified',
});
