import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyEarningsController } from '../controllers/agency-earnings.controller';
import { PayoutRequestController } from '../controllers/payout-request.controller';

/**
 * Agency earnings routes. Mounted at `/api/agency` → `/agency/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

router.get('/earnings', AgencyEarningsController.getEarnings);

// Request a payout of the entire available balance; opens a PAYOUT_REQUEST ticket.
router.post('/earnings/payout', PayoutRequestController.requestPayout);
router.get('/earnings/payout', PayoutRequestController.getCurrent);

export default router;
