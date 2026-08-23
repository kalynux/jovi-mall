import { Router } from 'express';
import { AuthController } from './auth.controller';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { ContactChangeController } from '../users/contact-change.controller';

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

/**
 * Confirm a change of login email (Phase 6 · 6.D.1).
 *
 * **Public on purpose, and it sits here rather than under `/api/me` for two reasons.** The
 * token arrives in a mail client — routinely a different browser, often a different device
 * — so requiring the session that *started* the change would fail the flow for exactly the
 * people it is for. And it spends a bearer secret, which is what the `/auth` prefix's
 * credential bucket (20/min/IP) exists to bound; `rate-limit/auth-paths.ts` is an
 * allowlist, so **not** naming it there is how it gets the strict counter rather than the
 * looser session one.
 *
 * The request half of the flow — which is what needs the account — is
 * `PATCH /api/me/email`, behind `requireAuth`. `login_email` moves only here.
 *
 * A `POST`, not the `GET` its sibling `verify-email` uses above. `PasswordResetService`
 * makes the argument in full: mail clients and chat apps *prefetch* URLs to build preview
 * cards, so a `GET` that mutates is spent by a crawler before the person taps it. The link
 * in the message points at the storefront, which POSTs here.
 */
router.post('/email-change/confirm', ContactChangeController.confirmEmail);

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
