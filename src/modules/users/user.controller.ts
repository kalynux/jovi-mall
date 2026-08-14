import { Request, Response } from 'express';
import { UserService } from './user.service';
import { UpdatePasswordSchema } from './user.validator';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { issueTokenPair } from '../../core/auth/token.issuer';
import { setAuthCookies } from '../../config/cookie.config';

const userService = new UserService();

/**
 * User Account Controller
 *
 * Role-agnostic account endpoints (mounted at /api/me). The password lives on
 * the User model, not on any role entity, so changing it is the same operation
 * for every role — the owner is resolved from req.auth, like /me/payment-methods.
 */
export class UserController {
  static updatePassword = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const input = UpdatePasswordSchema.parse(req.body);
    await userService.changePassword(userId, input.oldPassword, input.newPassword, {
      role: req.auth!.role,
      roleEntityId: req.auth!.role_entity._id.toString(),
    });

    /**
     * Re-issue the caller's own pair.
     *
     * The change just invalidated every token minted under the old password — including the
     * one this request arrived with. Without this line the person who changed their own
     * password is signed out by their own action, on the very next request, which reads as a
     * broken feature and teaches people not to use it.
     *
     * The eviction still holds for everyone else: only this request's authenticated caller
     * gets a replacement, and the tokens it replaces cannot be reused to obtain another. The
     * new pair is minted AFTER the epoch was stamped, so it outlives it — see the
     * whole-second note in `core/auth/password-epoch.ts` for why "after" is safe to within a
     * second rather than a millisecond.
     *
     * Cookies only, no tokens in the body: that is how every other credential in this
     * service is handed out (`AuthController.login` included), and a token in a response
     * body is a token in a client log.
     *
     * Minted through `core/auth/token.issuer` rather than `AuthService`: signing two JWTs
     * should not require constructing five repositories, a mail service and two provisioning
     * services, which is what importing that class into this module would pull in at load
     * time. See that file.
     */
    const { accessToken, refreshToken } = issueTokenPair(userId, req.auth!.role);
    setAuthCookies(res, accessToken, refreshToken);

    res.json({
      success: true,
      message: 'Password updated successfully. All other sessions have been signed out.',
    });
  });
}
