/**
 * The password epoch — how this service revokes sessions without a session store.
 *
 * jovi-mall's tokens are stateless JWTs. There is no server-side record of an issued
 * token, so there is nothing to delete when somebody changes their password: the only way
 * to end a session is to make the token itself unacceptable on its next use. That is what
 * `User.password_changed_at` is — a per-account revocation instant. Every token carries the
 * second it was minted (`iat`), and a token minted before the epoch was minted under the
 * OLD password.
 *
 * The check has to run on BOTH credentials to mean anything. The refresh cookie lives 30
 * days, so gating it is what actually evicts an attacker; the access token lives 15
 * minutes, so gating it too is what stops them working for a further quarter of an hour
 * after the victim believed they had locked the door. Both call sites already have the user
 * row in hand, so neither costs a query.
 *
 * ── Why whole SECONDS, and why `<` rather than `<=` ───────────────────────────
 * A JWT's `iat` is `floor(now / 1000)` — a whole second — while `password_changed_at` is a
 * millisecond instant. The change and the caller's replacement token pair are issued in the
 * same request, milliseconds apart, so a millisecond comparison rejects the brand-new token
 * roughly half the time: change at `…10.500`, replacement `iat` = `…10` → `10000 < 10500`.
 * Comparing whole seconds with `<` reads as "minted in a strictly earlier second than the
 * change", which keeps that token valid.
 *
 * The cost is a sub-second window in which a token minted in the same second as the change
 * outlives it. That is not a weakening worth engineering around: whoever holds a token in
 * that window held one a second earlier too.
 */

/**
 * Was this token minted under a password that has since been changed?
 *
 * @param issuedAtSeconds - the token's `iat` claim, in whole seconds
 * @param passwordChangedAt - `User.password_changed_at`, or null for an account that has
 *                            never changed its password since the field existed
 */
export function isTokenPredatingPasswordChange(
    issuedAtSeconds: number | undefined | null,
    passwordChangedAt: Date | null | undefined,
): boolean {
    // No epoch: nothing to be behind. Every token ever issued for this account stays
    // acceptable, which is exactly what makes the column need no backfill — a row that
    // predates it reads as "never changed" and behaves as it always did.
    if (!passwordChangedAt) return false;

    // `new Date(…)` rather than `.getTime()` on the argument: this is reached from a Mongoose
    // document today, but a lean read or a cached shape would hand over a string, and a
    // TypeError inside `requireAuth` is a 500 on every authenticated request.
    const changedAtMs = new Date(passwordChangedAt).getTime();
    if (!Number.isFinite(changedAtMs)) return false;

    // Fail CLOSED on a token we cannot date. Every token this service signs carries `iat`
    // (jsonwebtoken adds it unless told otherwise), so one without it was assembled by hand
    // — and this branch is only reachable for an account that HAS changed its password,
    // which is precisely the account whose older sessions must not survive.
    if (typeof issuedAtSeconds !== 'number' || !Number.isFinite(issuedAtSeconds)) return true;

    return issuedAtSeconds < Math.floor(changedAtMs / 1000);
}
