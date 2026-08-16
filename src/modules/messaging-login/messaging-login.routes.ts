import { Router } from 'express';
import { MessagingLoginController } from './messaging-login.controller';

/**
 * Passwordless sign-in redemption, mounted at `/api/auth/magic`.
 *
 * ── THE MOUNT POINT IS A SECURITY DECISION ───────────────────────────────────
 * `/api/auth` is where the credential rate-limit bucket lives — 20/min/IP, the
 * one strict number in `api/rate-limit/policy.ts` and the control aimed at
 * password spraying. `api/index.ts` mounts `authBucketDispatcher` on the whole
 * `/auth` prefix, so anything routed beneath it inherits that bucket without
 * declaring anything.
 *
 * Critically, `rate-limit/auth-paths.ts` is an **ALLOWLIST**: a path is only
 * moved to the looser `auth_session` bucket (300/min) by being named there.
 * These two are not named, so they get the strict bucket by default — which is
 * the right direction, because they ARE credential endpoints. They present a
 * bearer secret and mint a session; that is the same thing a login does.
 *
 * `test:messaging-login` source-scans for this. The invariant is structural and
 * a regression is invisible in behaviour until somebody is brute-forcing it.
 *
 * ── No guard, and no `requireAuth` ───────────────────────────────────────────
 * Both endpoints are how a caller BECOMES authenticated, so they are public in
 * the same sense `POST /auth/login` and `POST /auth/reset-password` are: the
 * credential in the body is the whole authentication.
 */
const router = Router();

router.post('/link', MessagingLoginController.redeemLink);
router.post('/code', MessagingLoginController.redeemCode);

export const messagingLoginRoutes = router;
