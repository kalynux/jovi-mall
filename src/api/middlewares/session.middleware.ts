import { Request, Response, NextFunction } from 'express';
import { SessionService } from '../../modules/auth/services/session.service';
import { COOKIE_NAME } from '../../config/cookie.config';

const sessionService = new SessionService();

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            sessionId?: string;
        }
    }
}

/**
 * Session-based authentication middleware
 * Validates session cookie and attaches user to req.auth
 * Does NOT check Bearer tokens - use requireAuth for that
 */
export const requireSessionAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        // Debug logging
        console.log('Session middleware - cookies:', req.cookies);
        console.log('Session middleware - COOKIE_NAME:', COOKIE_NAME);

        // Read session cookie
        const sessionId = req.cookies?.[COOKIE_NAME];

        console.log('Session middleware - sessionId:', sessionId);

        if (!sessionId) {
            console.log('Session middleware - No session cookie found');
            res.status(401).json({ error: 'Unauthorized: No session' });
            return;
        }

        // Validate session
        console.log('Session middleware - Validating session:', sessionId);
        const { userId, user } = await sessionService.validateSession(sessionId);
        console.log('Session middleware - Session valid for user:', userId);

        // Attach to request (same format as requireAuth middleware)
        req.auth = {
            user,
            role: user.roles[0], // Use first role from roles array
            role_entity: null, // Will be populated if needed
        };

        // Also attach sessionId for OAuth state generation
        req.sessionId = sessionId;

        next();
    } catch (error: any) {
        // Session invalid or expired
        console.log('Session middleware - Error:', error.message);
        res.status(401).json({
            error: 'Unauthorized: Invalid or expired session',
            message: error.message
        });
    }
};

/**
 * Middleware to enforce JSON-only POST requests (CSRF protection)
 * Rejects form-encoded POSTs from browsers
 */
export const requireJsonContent = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const contentType = req.headers['content-type'];

        if (!contentType || !contentType.includes('application/json')) {
            res.status(400).json({
                error: 'Bad Request: Only JSON content is accepted'
            });
            return;
        }
    }

    next();
};
