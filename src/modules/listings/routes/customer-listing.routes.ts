import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { CustomerListingController } from '../controllers/customer-listing.controller';

/**
 * The customer side of service listings (SERVICE-LISTINGS-PLAN § C-3, walk-order step 6).
 *
 *   /api/me/listings/:listingId/reveal      POST { field } → RevealResult
 *   /api/me/listing-consents                GET, PUT /:vendorId { granted }
 *
 * Mounted in `api/index.ts` ABOVE `/me`, each at its own prefix. A customer session only — a
 * vendor or agency session, even on the same account, does not unlock a provider's contacts.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['customer']));
router.post('/:listingId/reveal', CustomerListingController.reveal);

export const customerListingConsentRoutes = Router();
customerListingConsentRoutes.use(requireAuth);
customerListingConsentRoutes.use(requireRole(['customer']));
customerListingConsentRoutes.get('/', CustomerListingController.listConsents);
customerListingConsentRoutes.put('/:vendorId', CustomerListingController.setConsent);

export default router;
