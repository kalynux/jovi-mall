import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { VendorListingSettingsController } from '../controllers/vendor-listing.controller';

/**
 * `/api/vendor/listing-settings` — a provider's L-10 / L-11 / L-30 settings
 * (`{ onEmpty, debtFloor, maxCreditsPerCustomerPerDay }`). Own prefix, so the router-level
 * provider guard is safe (see `vendor-listing.routes.ts`).
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['vendor']));
router.use(requireVendorKind('provider'));

router.get('/', VendorListingSettingsController.get);
router.put('/', VendorListingSettingsController.put);

export default router;
