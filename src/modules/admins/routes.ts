import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminProfileController } from './controllers/admin-profile.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

/** GET /api/admin/profile — returns self-profile including last_login_ip */
router.get('/profile', AdminProfileController.getProfile);

/** PATCH /api/admin/profile */
router.patch('/profile', AdminProfileController.updateProfile);

export default router;
