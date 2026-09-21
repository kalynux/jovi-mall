import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { UserController } from './user.controller';
import { ContactChangeController } from './contact-change.controller';
import { PhoneVerificationController } from '../phone-verification/phone-verification.controller';
import connectionRoutes from '../channel-connections/channel-connection.routes';

const router = Router();

/**
 * User Account Routes (mounted at /api/me)
 *
 * Shared across all roles — no requireRole guard. The account owner is
 * resolved from the auth token.
 */
router.use(requireAuth);

/**
 * PATCH /api/me/password
 *
 * Change the authenticated user's password (any role).
 * Body: { oldPassword, newPassword }
 */
router.patch('/password', UserController.updatePassword);

/**
 * Contact change — /api/me/{contact,email,phone} (Phase 6 · 6.D.1)
 *
 * ⚠ **The confirm for EMAIL is not here.** It is `POST /api/auth/email-change/confirm`,
 * unauthenticated, because the token arrives in a mail client rather than in the browser
 * that started the change — see `ContactChangeController.confirmEmail`. The phone confirm
 * *is* here, because its proof is a property of the account and needs the session to be
 * looked up at all. That asymmetry is the design, not an oversight; both are documented
 * in `api-doc/me/contact-change.md`.
 *
 * `/email/pending` and `/phone/pending` are declared as literals under paths that carry no
 * `:param` sibling, so no ordering hazard exists today. Keep it that way: a `/:id` added
 * under `/email/` later must be declared AFTER these.
 */
router.get('/contact', ContactChangeController.getState);

router.patch('/email', ContactChangeController.requestEmail);
router.delete('/email/pending', ContactChangeController.cancelEmail);

router.patch('/phone', ContactChangeController.requestPhone);
router.post('/phone/confirm', ContactChangeController.confirmPhone);
router.delete('/phone/pending', ContactChangeController.cancelPhone);

/**
 * WhatsApp OTP — the SECOND proof of a phone number.
 *
 * `/phone/confirm` above proves a number by requiring an existing WhatsApp CONNECTION on it: a
 * message actually arrived from that number, which is stronger than any code we send
 * ourselves. That works for customers, who reach the platform through the bot.
 *
 * It cannot work for vendors, agencies, agents or administrators — they sign up on a dashboard
 * and may never message the platform, so there is no connection to check and `phone_verified`
 * could never become true for them. These three routes are that path.
 *
 * ⭐ **Customers use them too, on the storefront** (owner decision, 2026-09-21): a customer
 * changing their number gets the code rather than being told to message the bot from it.
 * `/phone/confirm` above stays for the bot surface. None of these routes is role-gated.
 *
 * ⚠ Every segment here is a LITERAL and no `:param` is declared under `/phone`, so nothing
 * shadows anything. Check that again before adding `/phone/:id`.
 */
router.get('/phone/verify', PhoneVerificationController.state);
router.post('/phone/verify/request', PhoneVerificationController.request);
router.post('/phone/verify/confirm', PhoneVerificationController.confirm);

/**
 * POST /api/me/close
 *
 * Close and anonymise the caller's own account — ADR-A02 D-1. Body:
 * `{ "confirm": "CLOSE MY ACCOUNT" }`.
 *
 * Customer-only accounts, and irreversible. Everything the word "close" is doing here is
 * deliberate: this anonymises and retains, and ADR-A02 D-2 forbids describing it as a
 * deletion or as satisfying a legal right.
 *
 * POST rather than DELETE: the account row is not removed, and `DELETE /api/me` would
 * promise on the wire exactly the thing the design refuses to do.
 */
router.post('/close', UserController.closeAccount);

/**
 * Messaging connections — /api/me/connections
 *
 * Mounted here rather than beside the bot webhooks, and that placement is the
 * point: `/api/webhooks/*` is rate-limit-exempt, which is where the WhatsApp and
 * Telegram linking endpoints this replaces had ended up. See
 * `modules/connections/connection.routes.ts`.
 */
router.use('/connections', connectionRoutes);

export default router;
