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

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}

export function generateAccessToken(userId: string, role: string): string {
    return jwt.sign({ userId, role }, getJwtSecret(), { expiresIn: ACCESS_TOKEN_TTL_S });
}

export function generateRefreshToken(userId: string, role: string): string {
    return jwt.sign(
        { userId, role, type: 'refresh' },
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
 */
export function issueTokenPair(userId: string, role: string): AuthTokens {
    return {
        accessToken: generateAccessToken(userId, role),
        refreshToken: generateRefreshToken(userId, role),
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
