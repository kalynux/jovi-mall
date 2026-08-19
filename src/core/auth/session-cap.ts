import { ABSOLUTE_SESSION_CAP_S } from './token.issuer';

/**
 * The absolute session cap — how one sign-in is bounded without a session store.
 *
 * ── The defect this closes (A-3 / ADR-A03) ────────────────────────────────────
 * Every credential-issuing path in this service mints a fresh pair at full lifetime, and
 * `auth-me` is called by every client on launch. So the 30-day refresh window slides forever:
 * a stolen refresh token an attacker keeps using never lapses, and the only remedies are a
 * password change or a suspension — both of which require somebody to KNOW.
 *
 * `auth_time` is the fix, and it is one claim rather than a collection. It records when the
 * person last PROVED something (a password at login or registration, or the single-use
 * credential the messaging bot handed them), and it is copied **byte-identical** through every
 * re-issue. The cap is then arithmetic on a claim the token already carries — no store, no new
 * collection, no boot-time state. That constraint is load-bearing rather than aesthetic:
 * `users.sessions.revoke` is unbuilt in wi-admin *precisely* because no session store exists,
 * and this must not quietly create one and leave that rationale stale.
 *
 * ── Where it is enforced, and why it is more than one place ───────────────────
 * Exactly the same argument as `password-epoch.ts`, and for the same reason:
 *
 *   • `rotateRefreshToken` is the EVICTION. The refresh credential lives 30 days, so this is
 *     what stops a capped session minting anything further.
 *   • `requireAuth` closes the tail AND the re-issue paths. Access tokens live 15 minutes, so
 *     gating the refresh alone would leave a capped session working for a further quarter of
 *     an hour — and, far worse, `authMe` and `addRole` sit behind `requireAuth` and BOTH mint
 *     a full fresh pair from a valid access token. A client polling `auth-me` every fourteen
 *     minutes never touches `rotateRefreshToken` at all, so gating only the rotation leaves
 *     the sliding window exactly as it was. That is the whole of A-3, reproduced.
 *
 * Both call sites already have the payload in hand, so neither costs a query.
 *
 * ── D-9: a token with no `auth_time` is dated from its own `iat` ──────────────
 * No grandfathering and no mass sign-out. Three options existed and two are wrong: treating a
 * missing claim as uncapped writes the hole into every session alive at deploy, and refusing
 * one signs out every client at deploy. The fallback is correct AND self-healing — every live
 * refresh token was minted within the last 30 days, so a legacy session is capped from at most
 * 30 days ago and gains a real `auth_time` on its first re-issue. Nobody is signed out on
 * deploy day.
 */

/** The claims this module reads. Both are whole seconds; `jsonwebtoken` writes `iat` itself. */
export interface SessionDatedPayload {
    auth_time?: number;
    iat?: number;
}

/**
 * When did this session start?
 *
 * @returns whole seconds, or `null` when the token carries neither claim — see the caller's
 *   note on what that means. It is not reachable for anything this service signed.
 */
export function resolveAuthTime(payload: SessionDatedPayload): number | null {
    if (typeof payload.auth_time === 'number' && Number.isFinite(payload.auth_time)) {
        return payload.auth_time;
    }
    // D-9. A token predating this feature is dated from its own mint.
    if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) {
        return payload.iat;
    }
    return null;
}

/**
 * Has this sign-in outlived the absolute cap?
 *
 * ⚠ **Fails CLOSED on a token that cannot be dated.** `jsonwebtoken` stamps `iat` on
 * everything this service signs, so a payload reaching here with neither claim was assembled
 * by hand — and an undateable token is exactly the one that must not be granted an unbounded
 * session. The same reasoning as `isTokenPredatingPasswordChange`'s undateable branch.
 *
 * @param payload - the VERIFIED token's claims. Never call this on a decoded-but-unverified
 *   one: `auth_time` is caller-controlled until the signature has been checked.
 */
export function isSessionCapReached(payload: SessionDatedPayload): boolean {
    const authTime = resolveAuthTime(payload);
    if (authTime === null) return true;

    return Math.floor(Date.now() / 1000) - authTime > ABSOLUTE_SESSION_CAP_S;
}
