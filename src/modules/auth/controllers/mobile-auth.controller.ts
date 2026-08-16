import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../auth.service';
import {
  AddRoleSchema,
  AuthMeSchema,
  LoginSchema,
  MobileRefreshSchema,
  RegisterSchema,
} from '../auth.schemas';
import { tokenEnvelope } from '../../../core/auth/token.issuer';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { sendSuccess, sendCreated } from '../../../core/responses';

/**
 * Bearer auth for clients that cannot hold a cookie — `/api/auth/mobile/*`.
 *
 * ── Why a namespace rather than a header on the existing routes ────────────────
 * A Capacitor / React Native WebView runs our JavaScript inside a browser engine, so two
 * things are true at once and neither is fixable client-side: its origin is
 * `capacitor://localhost` or `https://localhost`, which makes our cookie third-party and
 * blocked by default; and `Set-Cookie` is a *forbidden response-header name* in the Fetch
 * standard, stripped from every `Response.headers` object in every engine — so it cannot
 * scrape the token out the way a native HTTP client (the Flutter agent app's Dio stack) can.
 * It needs the tokens in the body.
 *
 * The alternative design was an `X-Client-Type: mobile` request marker branching the four
 * existing handlers. This is the same shape as `/api/auth/browser/*` instead, and it buys
 * three things the header does not: browser behaviour is unchanged **by construction** rather
 * than by a check somebody could get wrong; there is no non-safelisted header, so no preflight
 * on every request and no addition to geo-tracker's closed CORS header list; and there is no
 * name for two teams to keep in step.
 *
 * ── The one rule for this file ────────────────────────────────────────────────
 * **No `setAuthCookies`, no `res.cookie`, anywhere in it.** That absence is the whole point of
 * the namespace — setting a cookie a client provably cannot read is dead weight that makes
 * every debugging session harder. `test:mobile-auth` scans this file for both.
 *
 * Everything else is shared: every handler calls the *same* `AuthService` method its cookie
 * twin calls, so a rule added to login, registration or role resolution applies here without
 * anyone remembering to. The duplication against `auth.controller.ts` is the parse line and
 * the service call, and that is the honest price of not branching inside a shared handler.
 */

const authService = new AuthService();

export class MobileAuthController {

  /** POST /api/auth/mobile/login */
  static login = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const input = LoginSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.login(input);
    sendSuccess(res, {
      user,
      role,
      role_entity,
      tokens: tokenEnvelope({ accessToken, refreshToken }),
    });
  });

  /** POST /api/auth/mobile/register */
  static register = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const input = RegisterSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.register(input);
    sendCreated(res, {
      user,
      role,
      role_entity,
      tokens: tokenEnvelope({ accessToken, refreshToken }),
    });
  });

  /**
   * GET /api/auth/mobile/auth-me/:role — session restore on app launch.
   *
   * The one endpoint that is easy to overlook and must not be: it re-issues BOTH tokens at
   * full lifetime, which is what restarts the 30-day window. Without it a bearer client gets a
   * hard expiry 30 days after its last password entry regardless of how much it was used.
   */
  static authMe = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    const input = AuthMeSchema.parse({ userId, role: req.params.role });
    const {
      user, role: resolvedRole, role_entity, accessToken, refreshToken,
    } = await authService.authMe(input);

    sendSuccess(res, {
      user,
      role: resolvedRole,
      role_entity,
      tokens: tokenEnvelope({ accessToken, refreshToken }),
    });
  });

  /** POST /api/auth/mobile/add-role — the new pair is scoped to the role just added. */
  static addRole = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    const input = AddRoleSchema.parse(req.body);
    const { user, role, role_entity, accessToken, refreshToken } = await authService.addRole(userId, input);

    sendCreated(res, {
      user,
      role,
      role_entity,
      tokens: tokenEnvelope({ accessToken, refreshToken }),
    });
  });

  /**
   * POST /api/auth/mobile/refresh — the bearer twin of the refresh cookie.
   *
   * Public, because the refresh token IS the credential. Every check runs inside
   * `rotateRefreshToken`, which the cookie path shares — including the `type: 'refresh'`
   * claim, so an access token posted here is refused rather than quietly accepted.
   */
  static refresh = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const parsed = MobileRefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      // Same verdict as `POST /auth/browser/refresh` when its cookie is absent. A missing
      // credential is "no session", not a malformed request, and the client's response to
      // both is identical.
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized: No refresh token'));
    }

    const { accessToken, refreshToken } = await authService.rotateRefreshToken(parsed.data.refreshToken);

    sendSuccess(res, { tokens: tokenEnvelope({ accessToken, refreshToken }) });
  });
}
