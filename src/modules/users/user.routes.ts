import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { UserController } from './user.controller';
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
 * Messaging connections — /api/me/connections
 *
 * Mounted here rather than beside the bot webhooks, and that placement is the
 * point: `/api/webhooks/*` is rate-limit-exempt, which is where the WhatsApp and
 * Telegram linking endpoints this replaces had ended up. See
 * `modules/connections/connection.routes.ts`.
 */
router.use('/connections', connectionRoutes);

export default router;
