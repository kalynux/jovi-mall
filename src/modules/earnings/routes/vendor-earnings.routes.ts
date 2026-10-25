import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorEarningsController } from '../controllers/vendor-earnings.controller';
import { PayoutRequestController } from '../controllers/payout-request.controller';
import { EarningsExplanationsController } from '../controllers/earnings-explanations.controller';

/**
 * Vendor earnings routes. Mounted at `/api/vendor` → `/vendor/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

// Balances only. Earnings history moved to the unified GET /vendor/transactions feed.
router.get('/earnings', VendorEarningsController.getEarnings);

// Why money was taken back (refunds, seller-cancel fees, a lost dispute) and damage claims that
// compensated the vendor — 2026-10-22.
router.get('/earnings/adjustments', EarningsExplanationsController.listMyAdjustments);
router.get('/earnings/agency-claims', EarningsExplanationsController.listVendorClaims);

// Request a payout of the entire available balance; opens a PAYOUT_REQUEST ticket.
router.post('/earnings/payout', PayoutRequestController.requestPayout);
router.get('/earnings/payout', PayoutRequestController.getCurrent);

export default router;
