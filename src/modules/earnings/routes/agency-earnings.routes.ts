import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyEarningsController } from '../controllers/agency-earnings.controller';
import { PayoutRequestController } from '../controllers/payout-request.controller';
import { EarningsExplanationsController } from '../controllers/earnings-explanations.controller';

/**
 * Agency earnings routes. Mounted at `/api/agency` → `/agency/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

router.get('/earnings', AgencyEarningsController.getEarnings);

// Why money was taken back (a refund at the delivery's fault, a damage claim) — 2026-10-22.
router.get('/earnings/adjustments', EarningsExplanationsController.listMyAdjustments);
router.get('/earnings/claims', EarningsExplanationsController.listAgencyClaims);

// Request a payout of the entire available balance; opens a PAYOUT_REQUEST ticket.
router.post('/earnings/payout', PayoutRequestController.requestPayout);
router.get('/earnings/payout', PayoutRequestController.getCurrent);

export default router;
