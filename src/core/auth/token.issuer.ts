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
