import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { VendorListingController } from '../controllers/vendor-listing.controller';

/**
 * `/api/vendor/listings` — a service provider's listings (SERVICE-LISTINGS-PLAN § C-3).
 *
 * Mounted at its OWN prefix, so a router-level `requireVendorKind('provider')` is safe here: it
 * runs only for requests entering `/vendor/listings`, never for a later `/vendor/*` mount (the
 * trap § C-1 describes is specific to the three routers mounted at bare `/vendor`). A seller
 * reaching this surface gets `403 AUTH_VENDOR_KIND_FORBIDDEN`.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['vendor']));
router.use(requireVendorKind('provider'));

router.get('/', VendorListingController.list);
router.post('/', VendorListingController.create);
router.get('/:id', VendorListingController.get);
router.patch('/:id', VendorListingController.update);
router.post('/:id/submit', VendorListingController.submit);
router.post('/:id/withdraw', VendorListingController.withdraw);
router.delete('/:id/revision', VendorListingController.discardRevision);
router.post('/:id/archive', VendorListingController.archive);

export default router;
