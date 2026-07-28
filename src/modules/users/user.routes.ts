import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { UserController } from './user.controller';

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

export default router;
