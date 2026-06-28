import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorEarningsController } from '../controllers/vendor-earnings.controller';

/**
 * Vendor earnings routes. Mounted at `/api/vendor` → `/vendor/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

// Balances only. Earnings history moved to the unified GET /vendor/transactions feed.
router.get('/earnings', VendorEarningsController.getEarnings);

export default router;
