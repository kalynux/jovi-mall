import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorEarningsController } from '../controllers/vendor-earnings.controller';

/**
 * Vendor earnings routes. Mounted at `/api/vendor` → `/vendor/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

router.get('/earnings', VendorEarningsController.getEarnings);
router.get('/earnings/ledger', VendorEarningsController.getLedger);

export default router;
