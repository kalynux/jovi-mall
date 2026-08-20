import jwt from 'jsonwebtoken';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getJwtSecret } from '../../../config/secrets.config';

/**
 * Resolved per call, not at import time: `getJwtSecret()` throws when unset, and
 * a module-level const would turn that into an import-time crash whose stack
 * points at whichever file happened to import this one first.
 */
const oauthStateSecret = (): string => process.env.OAUTH_STATE_SECRET?.trim() || getJwtSecret();

const STATE_EXPIRATION = '5m'; // 5 minutes

interface OAuthStatePayload {
    userId: string;
    /**
     * Where the callback should hand control back to, when the caller is not the
     * web dashboard.
     *
     * A packaged app cannot receive `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL` — that
     * is a web origin, and the app is a WebView serving local files — so it asks
     * for its own custom-scheme URL (`wivendor://services/calendar`) and the OS
     * hands the redirect back to it. Riding inside the *signed* state rather
     * than a query parameter is what stops it being an open redirect: it cannot
     * be edited between the consent screen and the callback.
     *
     * Still validated against an allowlist when it is minted — see
     * `resolveReturnTo` in the Google routes. Never trust it just because it is
     * signed; "we signed it" only proves we minted it, not that it was checked.
     */
    returnTo?: string;
}

export class OAuthStateService {
    /**
     * Generate a signed OAuth state token
     * @param payload - userId to encode
     * @returns Signed state token
     */
    generateState(payload: OAuthStatePayload): string {
        return jwt.sign(
            {
                userId: payload.userId,
                ...(payload.returnTo ? { returnTo: payload.returnTo } : {}),
            },
            oauthStateSecret(),
            {
                expiresIn: STATE_EXPIRATION,
            }
        );
    }

    /**
     * Verify and decode an OAuth state token
     * @param state - State token to verify
     * @returns Decoded payload with userId and sessionId
     * @throws Error if state is invalid or expired
     */
    verifyState(state: string): OAuthStatePayload {
        try {
            const decoded = jwt.verify(state, oauthStateSecret()) as any;

            // `userId`, not `userId || sessionId`. The previous form admitted a
            // token carrying only `sessionId` and then returned `userId:
            // undefined` — harmless while the caller cross-checked the value
            // against its own cookie session, and an authentication hole the
            // moment it stopped. The Google callback now derives the user from
            // this payload alone, so an absent `userId` has to be a hard failure
            // here rather than a falsy value handed downstream.
            if (typeof decoded.userId !== 'string' || !decoded.userId) {
                throw createAppError(ERROR_CODES.AUTH_OAUTH_STATE_INVALID, 400, 'Invalid state payload');
            }

            return {
                userId: decoded.userId,
                ...(typeof decoded.returnTo === 'string' ? { returnTo: decoded.returnTo } : {}),
            };
        } catch (error: any) {
            if (error.name === 'TokenExpiredError') {
                throw createAppError(ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED, 400, 'OAuth state expired');
            }
            if (error.name === 'JsonWebTokenError') {
                throw createAppError(ERROR_CODES.AUTH_OAUTH_STATE_INVALID, 400, 'Invalid OAuth state');
            }
            throw error;
        }
    }
}
