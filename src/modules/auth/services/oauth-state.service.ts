import jwt from 'jsonwebtoken';

const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET || 'oauth-state-secret';
const STATE_EXPIRATION = '5m'; // 5 minutes

interface OAuthStatePayload {
    userId: string;
    sessionId: string;
}

export class OAuthStateService {
    /**
     * Generate a signed OAuth state token
     * @param payload - userId and sessionId to encode
     * @returns Signed state token
     */
    generateState(payload: OAuthStatePayload): string {
        return jwt.sign(
            {
                userId: payload.userId,
                sessionId: payload.sessionId,
            },
            OAUTH_STATE_SECRET,
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
            const decoded = jwt.verify(state, OAUTH_STATE_SECRET) as any;

            if (!decoded.userId || !decoded.sessionId) {
                throw new Error('Invalid state payload');
            }

            return {
                userId: decoded.userId,
                sessionId: decoded.sessionId,
            };
        } catch (error: any) {
            if (error.name === 'TokenExpiredError') {
                throw new Error('OAuth state expired');
            }
            if (error.name === 'JsonWebTokenError') {
                throw new Error('Invalid OAuth state');
            }
            throw error;
        }
    }
}
