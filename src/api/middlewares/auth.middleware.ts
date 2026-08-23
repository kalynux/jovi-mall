import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../../modules/users/user.repository';
import { CustomerRepository } from '../../modules/customers/customer.repository';
import { VendorRepository } from '../../modules/vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../modules/delivery/delivery-agency.repository';
import { AgentRepository } from '../../modules/agents';
import { AUTH_COOKIE, accessCookieOptions } from '../../config/cookie.config';
import { AuthService } from '../../modules/auth/auth.service';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { stampContextActor } from '../../core/logging/request-context';
import { identityRateLimiter } from '../rate-limit/rate-limit.middleware';
import { getJwtSecret } from '../../config/secrets.config';
import { isTokenPredatingPasswordChange } from '../../core/auth/password-epoch';
import { isSessionCapReached, resolveAuthTime } from '../../core/auth/session-cap';

// Module-level singletons
const userRepo = new UserRepository();
const customerRepo = new CustomerRepository();
const vendorRepo = new VendorRepository();
const agencyRepo = new DeliveryAgencyRepository();
const agentRepo = new AgentRepository();
const authService = new AuthService();

export interface AuthUserPayload {
  userId: string;
  role: string;
  /**
   * Whole seconds, added by `jsonwebtoken` on every token this service signs. Read only to
   * date the token against `User.password_changed_at` — see `core/auth/password-epoch.ts`.
   */
  iat?: number;
  /**
   * Whole seconds. When the person last PROVED a credential — copied unchanged through every
   * re-issue, so it dates the SIGN-IN rather than the token. See `core/auth/session-cap.ts`.
   * Optional because a token minted before ADR-A03 landed carries none; D-9 dates those from
   * their own `iat`.
   */
  auth_time?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user: import('../../modules/users/user.model').IUser;
        role: string;
        role_entity: any;
        /**
         * The verified token's session start, in whole seconds, with D-9's fallback already
         * applied. Present on everything `requireAuth` admits; absent on the synthetic
         * `req.auth` that `requireAdminCaller` builds from headers, which authenticates a
         * service token rather than a session and has no sign-in to date.
         *
         * The two routes that re-issue a pair from an access token (`auth-me`, `add-role`)
         * read it and COPY it — see `AuthService.authMe`.
         */
        auth_time?: number;
      };
      // Deprecated aliases kept for backward compatibility
      user?: import('../../modules/users/user.model').IUser;
      role?: string;
    }
  }
}

/** Where the access token came from. The silent refresh below branches on it. */
type TokenSource = 'bearer' | 'cookie';

/**
 * Resolves a JWT access token, and reports which door it came through.
 *
 * ── The BEARER is preferred, and that reversal is deliberate ──────────────────
 * This used to read the `access_token` cookie first and fall back to the header. A browser
 * never sets `Authorization` — none of the four dashboards does, and the only one that
 * builds the header at all points it at geo-tracker — so preferring the bearer is provably a
 * no-op for every cookie client, while it closes a genuinely hard-to-diagnose bug for native
 * ones: a WebView routed through a native HTTP layer inherits the OS cookie jar, and a stale
 * cookie beating a freshly-refreshed bearer produces 401s that look impossible from the
 * client side.
 *
 * An empty `Authorization: Bearer ` reports **no token at all**, not an empty one. The old
 * `split(' ')[1]` yielded `''`, which `if (!token)` routed to the no-credential branch; an
 * object-returning form that reported `{ token: '' }` would instead land in the verify branch
 * and answer `AUTH_TOKEN_INVALID`. Same extraction shape as `service-token.middleware.ts`.
 */
function extractToken(req: Request): { token: string; source: TokenSource } | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer) return { token: bearer, source: 'bearer' };
  }

  const cookieToken = req.cookies?.[AUTH_COOKIE.ACCESS];
  if (cookieToken) return { token: cookieToken, source: 'cookie' };

  return null;
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const extracted = extractToken(req);
  const token = extracted?.token ?? null;

  let payload: AuthUserPayload;

  if (!token) {
    // Access token cookie was deleted by the browser after expiry.
    // Attempt a silent refresh before rejecting the request.
    //
    // ⚠ This block is deliberately NOT gated on the token source, and the asymmetry with the
    // expired-token branch below is load-bearing rather than an oversight. Two live callers
    // depend on it, and both present a refresh cookie with no `Authorization` header at all:
    //   • every browser, once the 15-minute access cookie has expired and been deleted — this
    //     IS the ordinary browser path, not an edge case;
    //   • the Flutter agent app's second refresh path, which sends
    //     `GET /auth/auth-me/agent` with a hand-built `Cookie: refresh_token=…` and nothing
    //     else (`agent_app/…/auth/data/datasources/agent_token_refresher.dart`).
    // Tidying the two branches into symmetry signs both of them out.
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
        // …unless the caller presented a BEARER. A bearer client cannot read the cookie we
        // would set, so refreshing from an ambient cookie here would authenticate the request
        // as whoever that cookie belongs to while the client goes on sending its own expired
        // token — the same 401-that-looks-impossible the extraction order above exists to
        // prevent, one layer down. Fail closed; the client refreshes explicitly through
        // `POST /api/auth/mobile/refresh`.
        if (extracted?.source === 'bearer') {
          return next(createAppError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 401));
        }

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
  /**
   * A CLOSED account is refused first, and with its own code (ADR-A02 D-1).
   *
   * Ordering, not duplication: `closed` is not `active`, so the suspension guard below would
   * match it and tell somebody who anonymised their own account that it is "suspended" —
   * which reads as an appealable administrative decision and produces a support ticket
   * nobody can act on. This is also the ONE path a client realistically meets it on:
   * closure removes both login identifiers, so `login` can no longer resolve the account at
   * all, and what is left is the access token minted before the closure landed.
   */
  if (user.status === 'closed') {
    return next(createAppError(ERROR_CODES.AUTH_ACCOUNT_CLOSED, 403));
  }

  if (user.status !== 'active') {
    return next(
      createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended')
    );
  }

  /**
   * A token minted before the password changed is refused, on every authenticated request.
   *
   * `rotateRefreshToken` carries the same check and is the one that actually evicts — the
   * refresh cookie lives 30 days. This one closes the tail: access tokens are stateless and
   * live 15 minutes, so gating the refresh alone leaves whoever the change was aimed at
   * working for a further quarter of an hour, which is a long time to be inside an account
   * whose owner has just been told they locked it. The user row is already loaded
   * (`findById`, above), so this costs a comparison and no query — the same argument as the
   * suspension check.
   *
   * 401 rather than the suspension's 403: re-authenticating is exactly the remedy here, and
   * a browser client's silent refresh will meet this same verdict on the refresh path and
   * stop, rather than loop.
   */
  if (isTokenPredatingPasswordChange(payload.iat, user.password_changed_at)) {
    return next(createAppError(ERROR_CODES.AUTH_PASSWORD_CHANGED, 401));
  }

  /**
   * The 90-day absolute cap — ADR-A03, and the same two-call-site argument as the password
   * epoch directly above.
   *
   * `rotateRefreshToken` is the eviction; this closes the 15-minute access tail. But here it
   * does something the password check does not have to, and it is why the check is at
   * `requireAuth` rather than only at the rotation: **`auth-me` and `add-role` both mint a
   * full fresh pair from a valid access token**, and both sit behind this middleware. A
   * client polling `auth-me` inside the access lifetime never reaches `rotateRefreshToken`
   * at all — so gating the rotation alone would leave the sliding window exactly as A-3
   * found it, with an implementation that looks complete.
   *
   * No query: the payload is already verified and in hand.
   *
   * ⚠ Read from the VERIFIED payload, never from a decoded one. `auth_time` is
   * caller-controlled until the signature has been checked, and a forged one is a session
   * that never caps. Both branches above either `jwt.verify` or decode a token this service
   * has just minted.
   */
  if (isSessionCapReached(payload)) {
    return next(createAppError(ERROR_CODES.AUTH_SESSION_CAP_REACHED, 401));
  }

  /**
   * Load Role Entity.
   *
   * There is no `'admin'` branch, and its absence is load-bearing rather than
   * tidiness. Administrator identity belongs to the separate `wi-admin` database;
   * the legacy version of it here was a second, weaker one — no MFA, no session
   * revocation, no permission tier, no audit — and this was its last resolution
   * point. Nothing mints a token carrying that role any more (`register`,
   * `addRole`, `login` and `authMe` all refuse it), so a token presenting it is
   * either forged or predates the closure; either way it now falls through to the
   * 401 below with no entity.
   *
   * The wi-admin backend does NOT arrive here. It is authenticated by
   * `requireAdminCaller`, which synthesises `req.auth` from headers with no
   * database query — see `admin-caller.middleware.ts`.
   */
  let entity = null;
  const role = payload.role;

  if (role === 'customer') entity = await customerRepo.findByUserId(user.id);
  else if (role === 'vendor') entity = await vendorRepo.findByUserId(user.id);
  else if (role === 'agency') entity = await agencyRepo.findByUserId(user.id);
  else if (role === 'agent') entity = await agentRepo.findByUserId(user.id);

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

  // Attach to Request.
  //
  // `auth_time` carries D-9's fallback already applied, so the two re-issue routes behind
  // this middleware copy one number and never repeat the fallback logic. Non-null by
  // construction: `isSessionCapReached` above refuses any payload it cannot date.
  req.auth = { user, role, role_entity: entity, auth_time: resolveAuthTime(payload)! };

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
