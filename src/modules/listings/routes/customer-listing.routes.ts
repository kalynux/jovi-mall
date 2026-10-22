import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';

/**
 * The customer side of service listings (SERVICE-LISTINGS-PLAN § C-3, walk-order step 6).
 *
 *   /api/me/listings/:listingId/reveal      POST { field } → RevealResult
 *   /api/me/listing-consents                GET, PUT /:vendorId { granted }
 *
 * Mounted by the lead in wave 0 so the wave-2 builders never edit `api/index.ts`; the reveal
 * builder fills both routers. A customer session only — a vendor or agency session, even on the
 * same account, does not unlock a provider's contacts.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['customer']));

export const customerListingConsentRoutes = Router();
customerListingConsentRoutes.use(requireAuth);
customerListingConsentRoutes.use(requireRole(['customer']));

export default router;
