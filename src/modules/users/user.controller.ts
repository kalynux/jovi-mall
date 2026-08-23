import { Request, Response } from 'express';
import { UserService } from './user.service';
import { AccountClosureService } from './account-closure.service';
import { UpdatePasswordSchema, CloseAccountSchema } from './user.validator';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { issueTokenPair } from '../../core/auth/token.issuer';
import { setAuthCookies, clearAuthCookies } from '../../config/cookie.config';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

const userService = new UserService();
const accountClosureService = new AccountClosureService();

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
    /**
     * FRESH `auth_time` (the issuer's default), and this is a decision rather than an
     * oversight — D-8 states it explicitly.
     *
     * The user presented their OLD password to get here, so a credential was proved. And a
     * password change is this platform's only existing revocation: re-stamping the clock is
     * what keeps "change your password" a COMPLETE remedy after a compromise, rather than
     * one that leaves the victim's own new session carrying the attacker-era start date and
     * expiring early for no reason they can see. That property is what ADR-A03 exists to
     * preserve, not to weaken.
     */
    const { accessToken, refreshToken } = issueTokenPair(userId, req.auth!.role);
    setAuthCookies(res, accessToken, refreshToken);

    res.json({
      success: true,
      message: 'Password updated successfully. All other sessions have been signed out.',
    });
  });

  /**
   * POST /api/me/close — close and anonymise the caller's own account (ADR-A02 D-1).
   *
   * The account is always `req.auth`'s. There is no id in the path and none accepted in the
   * body (the schema is `.strict()`), so this endpoint cannot be aimed at anybody else.
   *
   * ── The role guard is HERE, not in the router ────────────────────────────────
   * `/api/me` is role-agnostic by design and carries no `requireRole`. Closure is defined
   * for a customer-only account and refuses every other shape, but the refusal has to name
   * WHICH roles blocked it — a `requireRole('customer')` on the route would answer 403 "not
   * your role" to a vendor who also holds `customer`, which is both true and useless. The
   * service raises `ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE` with `blockingRoles` instead.
   *
   * The 409 case is the guard that matters for a double-submit: the compare-and-set in the
   * repository, not this handler.
   */
  static closeAccount = asyncHandler(async (req: Request, res: Response) => {
    CloseAccountSchema.parse(req.body);

    const userId = req.auth!.user._id.toString();

    /**
     * A customer-only account whose active role is not `customer` cannot exist — but the
     * token names a role and the role entity is resolved from it, so this reads what it is
     * about to anonymise rather than assuming. A vendor token would have been refused by the
     * service's role guard a moment later anyway; this makes the failure a clear 422 instead
     * of a customer profile lookup against a vendor's id.
     */
    if (req.auth!.role !== 'customer') {
      throw createAppError(ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE, 422, undefined, {
        blockingRoles: [req.auth!.role],
      });
    }

    const customerId = req.auth!.role_entity._id.toString();
    const { closedAt } = await accountClosureService.close(userId, customerId);

    /**
     * Clear the cookies on the way out.
     *
     * The closure already revoked them — `password_changed_at` is stamped to the same
     * instant, so every token minted before it is refused on sight. This is the client-side
     * half: without it a browser keeps sending a cookie that will now 403 on every request,
     * and the person is left on a signed-in-looking page that fails everywhere. A bearer
     * client discards its own pair.
     */
    clearAuthCookies(res);

    res.json({
      success: true,
      // "Anonymised", not "deleted" — ADR-A02 D-2. The sentence is the product promise, and
      // it is deliberately specific about what survives, because the alternative is a
      // customer believing their orders are gone.
      message:
        'Your account has been closed and your personal details anonymised. '
        + 'Past orders are kept as business records, without your name or contact details.',
      data: { closedAt: closedAt.toISOString() },
    });
  });
}
