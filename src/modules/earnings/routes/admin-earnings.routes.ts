import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminEarningsController } from '../controllers/admin-earnings.controller';

/**
 * Admin earnings routes. Mounted at `/api/admin` → `/admin/earnings/platform`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

router.get('/earnings/platform', AdminEarningsController.getPlatformEarnings);
router.get('/earnings/platform/ledger', AdminEarningsController.getPlatformLedger);

export default router;
