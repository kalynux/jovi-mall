import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { VendorEarningsController } from '../controllers/vendor-earnings.controller';
import { PayoutRequestController } from '../controllers/payout-request.controller';

/**
 * Vendor earnings routes. Mounted at `/api/vendor` → `/vendor/earnings`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * Vendor kind, PER ROUTE (SERVICE-LISTINGS-PLAN § C-1): SELLER — a provider earns nothing
 * through Wi-Mall and has no payouts (L-2).
 *
 * ⚠ Never `router.use(requireVendorKind('seller'))` here: this router is mounted at bare
 * `/vendor`, so its `use` runs for every LATER `/vendor/*` mount too — `/vendor/transactions`,
 * `/vendor/tickets`, `/vendor/kyc` — and would lock providers out of all of them.
 * `test:service-listings` refuses that form in this file.
 */
const SELLER = requireVendorKind('seller');

// Balances only. Earnings history moved to the unified GET /vendor/transactions feed.
router.get('/earnings', SELLER, VendorEarningsController.getEarnings);

// Request a payout of the entire available balance; opens a PAYOUT_REQUEST ticket.
router.post('/earnings/payout', SELLER, PayoutRequestController.requestPayout);
router.get('/earnings/payout', SELLER, PayoutRequestController.getCurrent);

export default router;
