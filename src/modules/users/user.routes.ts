import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { UserController } from './user.controller';
import { ContactChangeController } from './contact-change.controller';
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
