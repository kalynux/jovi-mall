import crypto from 'crypto';
import { Session, ISession } from '../models/session.model';
import { IUser } from '../../users/user.model';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class SessionService {
    /**
     * Create a new session for a user
     * @param userId - User ID to create session for
     * @returns Session ID (cryptographically strong token)
     */
    async createSession(userId: string): Promise<string> {
        // Generate cryptographically strong session ID
        const sessionId = crypto.randomBytes(32).toString('hex');

        // Calculate absolute expiration (30 days from now, no sliding)
        const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

        // Create session document
        await Session.create({
            sessionId,
            userId,
            expiresAt,
        });

        return sessionId;
    }

    /**
     * Validate a session and return the associated user
     * @param sessionId - Session ID to validate
     * @returns User object if session is valid
     * @throws Error if session is invalid or expired
     */
    async validateSession(sessionId: string): Promise<{ userId: string; user: IUser }> {
        const session = await Session.findOne({ sessionId }).populate<{ userId: IUser }>('userId');

        if (!session) {
            throw new Error('Invalid session');
        }

        // Check absolute expiration
        if (new Date() > session.expiresAt) {
            // Clean up expired session
            await Session.deleteOne({ sessionId });
            throw new Error('Session expired');
        }

        return {
            userId: session.userId._id.toString(),
            user: session.userId,
        };
    }

    /**
     * Destroy a session (for logout)
     * @param sessionId - Session ID to destroy
     */
    async destroySession(sessionId: string): Promise<void> {
        await Session.deleteOne({ sessionId });
    }

    /**
     * Clean up all expired sessions (optional background job)
     * Note: MongoDB TTL index will auto-delete, but this can be used for manual cleanup
     */
    async cleanupExpiredSessions(): Promise<number> {
        const result = await Session.deleteMany({
            expiresAt: { $lt: new Date() },
        });
        return result.deletedCount || 0;
    }

    /**
     * Destroy all sessions for a user (useful for security events)
     * @param userId - User ID to destroy all sessions for
     */
    async destroyAllUserSessions(userId: string): Promise<number> {
        const result = await Session.deleteMany({ userId });
        return result.deletedCount || 0;
    }
}
