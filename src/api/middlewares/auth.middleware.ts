import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../../modules/users/user.repository';
import { CustomerRepository } from '../../modules/customers/customer.repository';
import { VendorRepository } from '../../modules/vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../modules/delivery/delivery-agency.repository';
import { AgentRepository } from '../../modules/agents';
import { AdminRepository } from '../../modules/admins/admin.repository';
import { AUTH_COOKIE, accessCookieOptions } from '../../config/cookie.config';
import { AuthService } from '../../modules/auth/auth.service';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { stampContextActor } from '../../core/logging/request-context';
import { identityRateLimiter } from '../rate-limit/rate-limit.middleware';
import { getJwtSecret } from '../../config/secrets.config';

// Module-level singletons
const userRepo = new UserRepository();
const customerRepo = new CustomerRepository();
const vendorRepo = new VendorRepository();
const agencyRepo = new DeliveryAgencyRepository();
const agentRepo = new AgentRepository();
const adminRepo = new AdminRepository();
const authService = new AuthService();

export interface AuthUserPayload {
  userId: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user: import('../../modules/users/user.model').IUser;
        role: string;
        role_entity: any;
      };
      // Deprecated aliases kept for backward compatibility
      user?: import('../../modules/users/user.model').IUser;
      role?: string;
    }
  }
}

/**
 * Resolves a JWT access token from:
 *   1. `access_token` httpOnly cookie (preferred, for browser clients)
 *   2. `Authorization: Bearer <token>` header (fallback, for API / mobile clients)
 */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE.ACCESS];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  return null;
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  let payload: AuthUserPayload;

  if (!token) {
    // Access token cookie was deleted by the browser after expiry.
    // Attempt a silent refresh before rejecting the request.
    const refreshToken = req.cookies?.[AUTH_COOKIE.REFRESH];

    // Never log the token itself — it is a long-lived credential, and this line
    // wrote one to stdout on every cookie-expiry refresh.
    if (!refreshToken) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    try {
      const refreshed = await authService.rotateRefreshToken(refreshToken);
      // Issue new access_token cookie transparently
      res.cookie(AUTH_COOKIE.ACCESS, refreshed.accessToken, accessCookieOptions);
      payload = jwt.decode(refreshed.accessToken) as AuthUserPayload;
    } catch {
      return next(createAppError(ERROR_CODES.AUTH_SESSION_EXPIRED, 401));
    }
  } else {
    try {
      payload = jwt.verify(token, getJwtSecret()) as AuthUserPayload;
    } catch (err: any) {
      // Access token is present but expired — attempt a silent, transparent refresh
      if (err.name === 'TokenExpiredError') {
        const refreshToken = req.cookies?.[AUTH_COOKIE.REFRESH];

        if (!refreshToken) {
          return next(createAppError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 401));
        }

        try {
          const refreshed = await authService.rotateRefreshToken(refreshToken);
          // Issue new access_token cookie transparently
          res.cookie(AUTH_COOKIE.ACCESS, refreshed.accessToken, accessCookieOptions);
          payload = jwt.decode(refreshed.accessToken) as AuthUserPayload;
        } catch {
          return next(createAppError(ERROR_CODES.AUTH_SESSION_EXPIRED, 401));
        }
      } else {
        // Token is corrupted, tampered, or uses an invalid signature
        return next(createAppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401));
      }
    }
  }

  // Load User
  const user = await userRepo.findById(payload.userId);
  if (!user) {
    return next(createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 401));
  }

  /**
   * A suspended account is refused HERE, on every authenticated request, and not only
   * at login.
   *
   * Access tokens are stateless and live 15 minutes, and the refresh cookie lives 30
   * days — so a suspension enforced at login alone would leave the suspended person
   * working for a quarter of an hour and then silently refreshing back in. The user row
   * is already loaded on this path (`findById`, one line above), so the check costs
   * nothing beyond the comparison.
   *
   * 403, not 401: the credential is valid and re-authenticating will not help. A 401
   * sends a browser client into a refresh loop against an account that is never coming
   * back.
   */
  if (user.status !== 'active') {
    return next(
      createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended')
    );
  }

  // Load Role Entity
  let entity = null;
  const role = payload.role;

  if (role === 'customer') entity = await customerRepo.findByUserId(user.id);
  else if (role === 'vendor') entity = await vendorRepo.findByUserId(user.id);
  else if (role === 'agency') entity = await agencyRepo.findByUserId(user.id);
  else if (role === 'agent') entity = await agentRepo.findByUserId(user.id);
  else if (role === 'admin') entity = await adminRepo.findByUserId(user.id);

  if (!entity) {
    return next(createAppError(ERROR_CODES.AUTH_ROLE_PROFILE_NOT_FOUND, 401));
  }

  /**
   * A suspended VENDOR is refused here — a separate axis from the account check above.
   *
   * `User.status` answers "may this person sign in at all"; `Vendor.status` answers "may
   * this shop operate". One account can hold both `vendor` and `customer`, so closing the
   * shop must not sign the same person out of their own shopping — which is exactly what
   * cascading the two would do.
   *
   * ── Why `=== 'inactive'` and not `!== 'active'` ───────────────────────────────
   * `pending_verification` is the schema DEFAULT at vendor registration, so the negated
   * form would refuse every vendor who never verified their email — a mass lockout on the
   * deploy that shipped it. `inactive` is written by exactly one thing, the administrative
   * suspension, so this check is provably a no-op against data that predates it.
   *
   * Do not "tidy" this into `!== 'active'`. `test-vendors.ts` asserts the narrow form is
   * what is in this file, precisely so that edit fails a suite instead of production.
   *
   * Only the vendor role: agencies and agents have their own status enums with their own
   * meanings and their own admin surfaces, and sweeping them in here would be a behaviour
   * change nobody asked for.
   *
   * 403 rather than 401, for the same reason as the account check: the credential is
   * valid and re-authenticating will not help.
   */
  // The cast narrows what `role === 'vendor'` already guarantees: TypeScript cannot
  // relate the role string to which member of the entity union was loaded above.
  if (role === 'vendor' && (entity as { status?: string }).status === 'inactive') {
    return next(
      createAppError(ERROR_CODES.AUTH_VENDOR_SUSPENDED, 403, 'This vendor account is suspended')
    );
  }

  // Attach to Request
  req.auth = { user, role, role_entity: entity };

  // Backward compatibility aliases
  req.user = user;
  req.role = role;
  (req as any).role_entity = entity;

  /**
   * Name the acting user on every log line this request produces.
   *
   * `stampContextActor` was previously called only by `requireAdminCaller`, so the join it
   * exists for — "what did this actor's request actually do inside the platform" — worked
   * for wi-admin administrators and for nobody else. One line, no query: the ALS store is
   * already open (`requestContextMiddleware`), and the logger's `mixin` reads it, so every
   * subsequent line, including bridged `console.*` calls, carries the actor.
   *
   * `'platform'` distinguishes this id's namespace from an administrator's — see
   * `core/types/actor-source.types.ts` for why a cross-database join cannot exist.
   */
  stampContextActor(String(user._id), 'platform');

  /**
   * Layer B — the per-role rate limit.
   *
   * Mounted HERE rather than on each router, and that is the design: `requireAuth` is the
   * single gate every authenticated route in the service passes through, so one line makes
   * the per-user-type ceilings live everywhere at once and a router added next year
   * inherits them without its author knowing they exist. Mounting per router would be
   * ~60 edits and one forgotten file away from a hole.
   *
   * It runs at the TAIL, after `req.auth` is populated, because that is the earliest point
   * where the caller's role is known from a VERIFIED token rather than from claims they
   * chose. Layer A has already counted this request against its IP; this counts it against
   * the person.
   */
  return identityRateLimiter(req, res, next);
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.role) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return next(createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, 'Insufficient permissions', {
        required: allowedRoles,
        actual: req.auth.role,
      }));
    }
    next();
  };
};
