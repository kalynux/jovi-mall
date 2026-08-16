import { Router } from 'express';
import { AuthController } from './auth.controller';
import { requireAuth } from '../../api/middlewares/auth.middleware';

const router = Router();

// ─── Public ──────────────────────────────────────────────────────────────────
router.post('/register', AuthController.register);
router.post('/login', AuthController.login);
router.get('/verify-email', AuthController.verifyEmail);

/**
 * Forgotten-password recovery. Both public, and both must be.
 *
 * `forgot-password` ALWAYS answers 200 — see the controller. `reset-password` takes a
 * single-use token and sets the new password without signing anybody in.
 *
 * Both inherit the credential bucket (20/min/IP) from the `/auth` mount in `api/index.ts`,
 * whose comment names password reset as one of the reasons it is mounted at the prefix
 * rather than per-route: a limiter attached by hand is one a new endpoint can forget.
 */
router.post('/forgot-password', AuthController.forgotPassword);
router.post('/reset-password', AuthController.resetPassword);

// ─── Cookie Token Management ─────────────────────────────────────────────────
/** Clear both auth cookies (always succeeds) */
router.post('/logout', AuthController.logout);

// ─── Authenticated ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, AuthController.me);
router.get('/auth-me/:role', requireAuth, AuthController.authMe);
router.post('/add-role', requireAuth, AuthController.addRole);
router.post('/send-email-verification', requireAuth, AuthController.sendEmailVerification);

/**
 * `POST /request-wa-verification` is GONE. It minted a code the user carried to
 * the WhatsApp bot; the direction is now inverted (the bot mints, the user
 * redeems) and the surface lives at `POST /api/me/connections`, which is
 * role-agnostic and rate-limited. See `modules/connections/`.
 */

export { router as authRouter };
