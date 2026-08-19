import jwt from 'jsonwebtoken';
import { getJwtSecret, getJwtRefreshSecret } from '../../config/secrets.config';

/**
 * Minting the token pair — extracted from `AuthService` so it can be reached without it.
 *
 * ── Why it is not only a method on AuthService ────────────────────────────────
 * It still is one, as a delegating wrapper: every existing caller is unchanged. What moved
 * is the weight. Signing a JWT needs `jsonwebtoken`, two secrets and two TTLs, while
 * `AuthService` constructs five repositories, a mail service, two provisioning services and
 * the agents barrel — importing it from a second module drags all of that into that module's
 * load graph, and this codebase already documents one boot crash caused by exactly that kind
 * of edge ("AuthService is not a constructor", see the agents barrel).
 *
 * The second caller is `UserController.updatePassword`, which re-issues the caller's own
 * pair after a password change has invalidated it.
 *
 * The payloads are byte-identical to what `AuthService` signed before the extraction —
 * `userId` was an ObjectId there and serialised to the same hex string.
 */

// ─── Token TTLs (in seconds) ─────────────────────────────────────────────────
export const ACCESS_TOKEN_TTL_S = parseInt(process.env.AUTH_ACCESS_TOKEN_TTL || '900');     // 15 min
export const REFRESH_TOKEN_TTL_S = parseInt(process.env.AUTH_REFRESH_TOKEN_TTL || '2592000'); // 30 days

/**
 * The absolute ceiling on one sign-in, in seconds. 90 days — ADR-A03 D-1.
 *
 * ── Why a session needs a ceiling at all ──────────────────────────────────────
 * Every credential-issuing path here mints a FRESH PAIR at full lifetime, and `auth-me` is
 * called by every client on launch — so the 30-day refresh window slides indefinitely and a
 * stolen refresh token an attacker keeps using never lapses. The two revocations that do
 * exist (a password change, a suspension) both require somebody to *know*. This is the one
 * that does not.
 *
 * ── Why 90 days ──────────────────────────────────────────────────────────────
 * A bearer client cannot renew silently inside an ordinary GET the way a cookie client can,
 * so every cap is a VISIBLE sign-out. 90 days is long enough that a real user meets it as a
 * rare event rather than as friction, and short enough that a stolen credential does not
 * outlive a quarter.
 *
 * It is deliberately **not** derived from `REFRESH_TOKEN_TTL_S`. The two answer different
 * questions — "how long may this token go unused" versus "how long may this sign-in last" —
 * and expressing one as a multiple of the other means changing the refresh TTL silently moves
 * the security ceiling.
 */
export const ABSOLUTE_SESSION_CAP_S = parseInt(
    process.env.AUTH_ABSOLUTE_SESSION_CAP || '7776000',
); // 90 days

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}

/**
 * The `auth_time` a fresh sign-in is stamped with.
 *
 * Whole seconds, matching `iat`'s unit — the two are compared against each other by
 * `resolveAuthTime`'s D-9 fallback, and by nothing that would tolerate a unit mismatch.
 */
export function nowAuthTime(): number {
    return Math.floor(Date.now() / 1000);
}

export function generateAccessToken(userId: string, role: string, authTime: number): string {
    return jwt.sign({ userId, role, auth_time: authTime }, getJwtSecret(), {
        expiresIn: ACCESS_TOKEN_TTL_S,
    });
}

export function generateRefreshToken(userId: string, role: string, authTime: number): string {
    return jwt.sign(
        { userId, role, type: 'refresh', auth_time: authTime },
        getJwtRefreshSecret(),
        { expiresIn: REFRESH_TOKEN_TTL_S },
    );
}

/**
 * Both halves, always together.
 *
 * `jsonwebtoken` stamps `iat` on each without being asked, and that claim is load-bearing:
 * it is what `isTokenPredatingPasswordChange` measures against `User.password_changed_at`.
 * Never sign one of these with `noTimestamp`.
 *
 * ── `authTime` and its default, which is the trap ─────────────────────────────
 * `auth_time` is when the person last PROVED something — a password, or a single-use
 * credential the bot handed them. It is stamped fresh there and copied **unchanged**
 * everywhere else; `core/auth/session-cap.ts` measures the cap against it.
 *
 * The default is "now", which makes every *fresh* issue correct with no argument at the call
 * site and leaves the calls that must NOT take it — the rotation, and the two re-issues that
 * sit behind `requireAuth` — as the only ones obliged to pass a value. That is the right way
 * round: a new sign-in path added later is capped by default, and the dangerous case is the
 * one you have to type.
 *
 * ⚠ It is deliberately NOT optional on the two `generate*` functions above. Forgetting it
 * there must not compile, because a token minted with no `auth_time` falls back to its own
 * `iat` (D-9) — which is to say, it re-stamps itself on every rotation and the cap silently
 * stops existing.
 */
export function issueTokenPair(
    userId: string,
    role: string,
    authTime: number = nowAuthTime(),
): AuthTokens {
    return {
        accessToken: generateAccessToken(userId, role, authTime),
        refreshToken: generateRefreshToken(userId, role, authTime),
    };
}

/**
 * A token pair as it is handed to a client that has to hold it itself.
 *
 * The lifetimes are in SECONDS, matching every other TTL on the wire here.
 */
export interface DeliveredTokens extends AuthTokens {
    accessExpiresIn: number;
    refreshExpiresIn: number;
}

/**
 * Wrap a freshly-minted pair with the lifetimes it was actually signed with.
 *
 * ── Why this lives HERE and not beside `setAuthCookies` ───────────────────────
 * The two constants above are the arguments `jwt.sign` receives, so building the published
 * numbers from them makes "the lifetime we tell the client" and "the lifetime we signed" the
 * same expression rather than two readings of one environment variable that happen to agree.
 * A cookie client never needed this — the browser enforces `maxAge` for it — but a bearer
 * client refreshes on a timer it sets from these, so a drift of one is a client refreshing at
 * the wrong moment, which surfaces as intermittent 401s and nothing else.
 *
 * `config/cookie.config.ts` imports the same two constants for its `maxAge`, so the cookie and
 * the body cannot disagree either.
 */
export function tokenEnvelope(tokens: AuthTokens): DeliveredTokens {
    return {
        ...tokens,
        accessExpiresIn: ACCESS_TOKEN_TTL_S,
        refreshExpiresIn: REFRESH_TOKEN_TTL_S,
    };
}
