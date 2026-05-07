import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AuthService } from '../auth.service';
import { LoginSchema } from '../auth.schemas';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
    AUTH_COOKIE,
    accessCookieOptions,
    refreshCookieOptions,
    clearCookieOptions,
} from '../../../config/cookie.config';

const authService = new AuthService();

/**
 * BrowserAuthController
 *
 * Handles browser-specific auth endpoints at /api/auth/browser/*.
 * Previously used opaque session IDs stored in MongoDB — now replaced with
 * the same JWT cookie strategy as the main auth flow, ensuring a single,
 * consistent session mechanism across all clients.
 *
 * Required for: OAuth flows (Google Calendar, etc.) that redirect back to the
 * browser and need cookie-based auth without an explicit login call.
 */
export class BrowserAuthController {

    /**
     * POST /api/auth/browser/login
     * Issues access_token and refresh_token cookies for browser clients.
     */
    login = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const input = LoginSchema.parse(req.body);
        const { user, role, role_entity, accessToken, refreshToken } = await authService.login(input);

        res.cookie(AUTH_COOKIE.ACCESS, accessToken, accessCookieOptions);
        res.cookie(AUTH_COOKIE.REFRESH, refreshToken, refreshCookieOptions);

        res.status(200).json({
            success: true,
            user: {
                id: user._id,
                email: user.login_email,
                role,
            },
        });
    });

    /**
     * POST /api/auth/browser/refresh
     * Issues a new access_token cookie from the existing refresh_token cookie.
     */
    refresh = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const refreshToken = req.cookies?.[AUTH_COOKIE.REFRESH];
        if (!refreshToken) {
            return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized: No refresh token'));
        }

        const { accessToken, user, role } = await authService.rotateRefreshToken(refreshToken);

        res.cookie(AUTH_COOKIE.ACCESS, accessToken, accessCookieOptions);

        res.status(200).json({
            success: true,
            message: 'Access token refreshed',
            user: { id: user._id, role },
        });
    });

    /**
     * POST /api/auth/browser/logout
     * Clears both auth cookies. No server-side state to invalidate (JWT is stateless).
     */
    logout = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        res.clearCookie(AUTH_COOKIE.ACCESS, clearCookieOptions);
        res.clearCookie(AUTH_COOKIE.REFRESH, clearCookieOptions);

        res.status(200).json({ success: true, message: 'Logged out successfully' });
    });
}
