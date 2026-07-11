import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyEarningsController } from '../controllers/agency-earnings.controller';

/**
 * Agency earnings routes. Mounted at `/api/agency` → `/agency/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

router.get('/earnings', AgencyEarningsController.getEarnings);

export default router;
