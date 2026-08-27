import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AuthService } from './auth.service';
import {
  LoginSchema,
  RegisterSchema,
  AddRoleSchema,
  AuthMeSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from './auth.schemas';
import { passwordResetService } from './services/password-reset.service';
import { setAuthCookies, clearAuthCookies } from '../../config/cookie.config';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess, sendCreated, sendMessage } from '../../core/responses';

const authService = new AuthService();

// `setAuthCookies` / `clearAuthCookies` moved to `config/cookie.config.ts` — a second
// caller needed them (UserController.updatePassword re-issues the pair after a password
// change) and the pairing rule belongs with the cookies, not with these routes.

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
   * POST /api/auth/forgot-password
   *
   * ⚠️ **Always answers 200 with the same body**, whether or not the identifier matches an
   * account. Any observable difference makes this an account-enumeration oracle — feed it a
   * list of phone numbers and learn which ones bank here. The service is written to return
   * quietly rather than throw for exactly that reason; do not "improve" the error handling
   * by surfacing a 404.
   *
   * Inherits the 20/min/IP credential bucket from the `/auth` mount, which is what stops
   * the uniform response being brute-forced for timing instead.
   */
  static forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = ForgotPasswordSchema.parse(req.body ?? {});
    await passwordResetService.requestReset(identifier);
    sendMessage(res, 'If that account exists, a password reset link has been sent.');
  });

  /**
   * POST /api/auth/reset-password
   *
   * Redeems a single-use token and sets the new password. Does **not** sign the caller in:
   * the link arrives by email or WhatsApp, either of which may be read on a device that is
   * not the one asking, so issuing a session here would hand it to whoever opened the
   * message. They sign in with the new password through the normal path.
   *
   * The write revokes every other session — `UserRepository.updatePassword` stamps
   * `password_changed_at`, and the password-epoch check refuses any token older than it.
   */
  static resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword } = ResetPasswordSchema.parse(req.body ?? {});
    await passwordResetService.resetPassword(token, newPassword);
    sendMessage(res, 'Your password has been reset. Please sign in with your new password.');
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
    // `auth_time` is set by `requireAuth` on everything it admits, so its absence means no
    // verified token reached here — which is exactly what AUTH_MISSING_TOKEN says. Reading it
    // in the same guard is what makes it impossible to call `authMe` without one.
    const authTime = req.auth?.auth_time;
    if (!userId || authTime === undefined) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    const { role } = req.params;
    const input = AuthMeSchema.parse({ userId, role });
    const { user, role: resolvedRole, role_entity, accessToken, refreshToken } = await authService.authMe(input, authTime);
    setAuthCookies(res, accessToken, refreshToken);
    sendSuccess(res, { user, role: resolvedRole, role_entity });
  });

  static addRole = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    const authTime = req.auth?.auth_time;   // copied, not re-stamped — see `AuthService.addRole`
    if (!userId || authTime === undefined) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    const input = AddRoleSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.addRole(userId, input, authTime);
    setAuthCookies(res, accessToken, refreshToken);
    sendCreated(res, { user, role, role_entity });
  });

  static sendEmailVerification = asyncHandler(async (req: Request, res: Response) => {
    const user = req.auth?.user;
    const role = req.auth?.role;
    const result = await authService.sendEmailVerification((user as any).id, role!);
    sendSuccess(res, result);
  });

  /**
   * `GET /auth/verify-email` — the LEGACY link, kept on purpose.
   *
   * ⚠ Do not delete it. Registration tokens live 24 hours (`EMAIL_VERIFY_EXPIRE`), so links
   * minted before the deploy that moved the mail to the storefront page stay valid for a
   * day after it. New mail points at that page, which POSTs to the sibling below.
   *
   * It is a `GET` that mutates, which is exactly why it is no longer what gets emailed —
   * see the comment on `AuthService.sendEmailVerification`.
   */
  static verifyEmail = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return next(createAppError(ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID, 400, 'Missing verification token'));
    }
    const result = await authService.verifyEmail(token);
    sendSuccess(res, result);
  });

  /**
   * `POST /auth/verify-email` — spend the token deliberately.
   *
   * Same handler shape, same service call, different verb: the storefront page holds the
   * token until a person acts, so a prefetcher cannot spend it first. That is the whole
   * point of the pair, and it is the argument `PasswordResetService` and
   * `ContactChangeController.confirmEmail` each make about their own tokens.
   *
   * Public, like its `GET` sibling — the token arrives from a mail client, routinely a
   * different browser and often a different device, so requiring the session that started
   * the verification would fail the flow for exactly the people it is for. The token is the
   * credential and it names the account; this handler reads no `req.auth`.
   *
   * Both verbs inherit the `/auth` prefix's credential bucket (20/min/IP), which is what a
   * bearer-secret spend should be counted against. `rate-limit/auth-paths.ts` is an
   * allowlist, so **not** naming this route there is how it gets the strict counter.
   */
  static verifyEmailPost = asyncHandler(async (req: Request, res: Response) => {
    const { token } = VerifyEmailSchema.parse(req.body);
    const result = await authService.verifyEmail(token);
    sendSuccess(res, result);
  });

}
