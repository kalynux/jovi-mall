import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AuthService } from '../auth.service';
import { SessionService } from '../services/session.service';
import { LoginSchema } from '../auth.schemas';
import { cookieConfig, COOKIE_NAME } from '../../../config/cookie.config';

const authService = new AuthService();
const sessionService = new SessionService();

export class BrowserAuthController {
    /**
     * POST /auth/browser/login
     * Browser-only login endpoint that uses cookies instead of Bearer tokens
     */
    async login(req: Request, res: Response) {
        try {
            // Validate request
            const input = LoginSchema.parse(req.body);

            // Authenticate user using existing AuthService
            const { user, role, role_entity } = await authService.login(input);

            // Create session
            const sessionId = await sessionService.createSession(user._id.toString());

            console.log("session id", sessionId);

            // Set httpOnly cookie
            res.cookie(COOKIE_NAME, sessionId, cookieConfig);

            // Return success (no token in body)
            res.send({
                success: true,
                user: {
                    id: user._id,
                    email: user.login_email,
                    role: role,
                },
            });
        } catch (error: any) {
            if (error instanceof ZodError) {
                res.status(400).json({
                    error: 'Validation Error',
                    details: error.errors
                });
                return;
            }

            res.status(401).json({
                error: 'Login failed',
                message: error.message
            });
        }
    }

    /**
     * POST /auth/browser/logout
     * Destroys session and clears cookie
     */
    async logout(req: Request, res: Response) {
        try {
            const sessionId = req.cookies?.[COOKIE_NAME];

            if (sessionId) {
                // Destroy session in database
                await sessionService.destroySession(sessionId);
            }

            // Clear cookie
            res.clearCookie(COOKIE_NAME, {
                path: cookieConfig.path,
                domain: cookieConfig.domain,
            });

            res.status(200).json({
                success: true,
                message: 'Logged out successfully',
            });
        } catch (error: any) {
            res.status(500).json({
                error: 'Logout failed',
                message: error.message
            });
        }
    }
}
