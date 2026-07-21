import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AuthService } from './auth.service';
import { LoginSchema, RegisterSchema, AddRoleSchema, AuthMeSchema } from './auth.schemas';
import {
  AUTH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
  clearCookieOptions,
} from '../../config/cookie.config';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess, sendCreated, sendMessage } from '../../core/responses';

const authService = new AuthService();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(AUTH_COOKIE.ACCESS, accessToken, accessCookieOptions);
  res.cookie(AUTH_COOKIE.REFRESH, refreshToken, refreshCookieOptions);
}

function clearAuthCookies(res: Response) {
  res.clearCookie(AUTH_COOKIE.ACCESS, clearCookieOptions);
  res.clearCookie(AUTH_COOKIE.REFRESH, clearCookieOptions);
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class AuthController {

  static register = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const input = RegisterSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.register(input);
    setAuthCookies(res, accessToken, refreshToken);
    sendCreated(res, { user, role, role_entity });
  });

  static login = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const input = LoginSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.login(input);
    setAuthCookies(res, accessToken, refreshToken);
    sendSuccess(res, { user, role, role_entity });
  });

  /**
   * POST /api/auth/logout
   * Clears both auth cookies.
   */
  static logout = asyncHandler(async (_req: Request, res: Response) => {
    clearAuthCookies(res);
    sendMessage(res, 'Logged out successfully');
  });

  static me = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const user = req.auth?.user;
    const role = req.auth?.role;
    const role_entity = req.auth?.role_entity;
    if (!user) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    sendSuccess(res, { user, role, role_entity });
  });

  static authMe = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    const { role } = req.params;
    const input = AuthMeSchema.parse({ userId, role });
    const { user, role: resolvedRole, role_entity, accessToken, refreshToken } = await authService.authMe(input);
    setAuthCookies(res, accessToken, refreshToken);
    sendSuccess(res, { user, role: resolvedRole, role_entity });
  });

  static addRole = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    const input = AddRoleSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.addRole(userId, input);
    setAuthCookies(res, accessToken, refreshToken);
    sendCreated(res, { user, role, role_entity });
  });

  static sendEmailVerification = asyncHandler(async (req: Request, res: Response) => {
    const user = req.auth?.user;
    const role = req.auth?.role;
    const result = await authService.sendEmailVerification((user as any).id, role!);
    sendSuccess(res, result);
  });

  static verifyEmail = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return next(createAppError(ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID, 400, 'Missing verification token'));
    }
    const result = await authService.verifyEmail(token);
    sendSuccess(res, result);
  });

  static requestWaVerification = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const user = req.auth?.user;
    const role = req.auth?.role;
    const { update_other_roles } = req.body;
    const result = await authService.issueWaVerificationCode((user as any).id, role!, update_other_roles);
    sendSuccess(res, result);
  });
}
