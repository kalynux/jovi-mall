import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../../modules/users/user.repository';
import { AUTH_COOKIE } from '../../config/cookie.config';
import { AuthUserPayload } from './auth.middleware';

const userRepo = new UserRepository();

/**
 * requireBrowserAuth
 *
 * Validates the `access_token` JWT cookie and attaches the user to req.auth.
 * This replaces the old session-ID-based `requireSessionAuth` middleware.
 *
 * Use this on routes that are ONLY intended for browser clients (e.g. OAuth
 * redirect flows where a Bearer header is not available).
 *
 * For all other routes, prefer `requireAuth` from auth.middleware.ts which
 * supports both cookie and Bearer header.
 */
// export const requireBrowserAuth = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ) => {
//     const token = req.cookies?.[AUTH_COOKIE.ACCESS];

//     if (!token) {
//         res.status(401).json({ error: 'Unauthorized: No access token cookie' });
//         return;
//     }

//     try {
//         const payload = jwt.verify(
//             token,
//             process.env.JWT_SECRET || 'secret'
//         ) as AuthUserPayload;

//         const user = await userRepo.findById(payload.userId);
//         if (!user) {
//             res.status(401).json({ error: 'Unauthorized: User not found' });
//             return;
//         }

//         req.auth = {
//             user,
//             role: payload.role,
//             role_entity: null, // Populate downstream if needed
//         };

//         req.user = user;
//         req.role = payload.role;

//         next();
//     } catch {
//         res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
//     }
// };

/**
 * requireJsonContent
 *
 * Rejects non-JSON POST/PUT/PATCH requests.
 * Acts as a lightweight CSRF mitigation: browsers cannot send
 * `application/json` cross-origin without a CORS preflight, which
 * the server controls via the origin allowlist.
 */
export const requireJsonContent = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.includes('application/json')) {
            res.status(400).json({ error: 'Bad Request: Only JSON content is accepted' });
            return;
        }
    }
    next();
};
