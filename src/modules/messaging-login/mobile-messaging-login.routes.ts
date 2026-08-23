import { Router } from 'express';
import { MobileMessagingLoginController } from './mobile-messaging-login.controller';

/**
 * Bearer redemption of a passwordless sign-in, mounted at `/api/auth/mobile/magic`.
 *
 * ── THE MOUNT POINT IS STILL A SECURITY DECISION ─────────────────────────────
 * Everything `messaging-login.routes.ts` says about its own mount applies here
 * unchanged, and it is worth restating because the path is longer and looks like
 * it might fall somewhere else.
 *
 * `api/index.ts` mounts `authBucketDispatcher` on the whole `/auth` prefix, so
 * these inherit the strict 20/min credential bucket by being routed beneath it.
 * `rate-limit/auth-paths.ts` is an **ALLOWLIST**: a path only moves to the
 * looser `auth_session` bucket by being named there, and neither of these is —
 * nor is any prefix that would cover them. `/api/auth/mobile/refresh` and
 * `/api/auth/mobile/auth-me` ARE named, but the match is anchored on the full
 * path, so neither swallows `/api/auth/mobile/magic/*`.
 *
 * That is the right direction: these ARE credential endpoints. They present a
 * bearer secret and mint a session, which is the same thing a login does.
 * `test:messaging-login` asserts it, because the invariant is structural and a
 * regression is invisible in behaviour until somebody is brute-forcing it.
 *
 * ── No `requireJsonContent`, and no guard ────────────────────────────────────
 * The browser namespace applies `requireJsonContent` as a CSRF mitigation, and
 * the mitigation works because a browser cannot send `application/json`
 * cross-origin without a preflight — which matters only when the request carries
 * an *ambient* credential the attacker does not hold. Nothing here reads or
 * writes a cookie, so there is no ambient credential to forge with. Same
 * reasoning as `routes/mobile-auth.routes.ts`.
 *
 * And no `requireAuth`: both endpoints are how a caller BECOMES authenticated,
 * so they are public in exactly the sense `POST /auth/login` is — the credential
 * in the body is the whole authentication.
 */
const router = Router();

router.post('/link', MobileMessagingLoginController.redeemLink);
router.post('/code', MobileMessagingLoginController.redeemCode);

export const mobileMessagingLoginRoutes = router;
