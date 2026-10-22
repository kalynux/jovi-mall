import { RequestHandler, Router } from 'express';
import { AdminListingController } from '../controllers/admin-listing.controller';

/**
 * Listing review — the write surface wi-admin delegates to (`/api/internal/admin/listings`,
 * SERVICE-LISTINGS-PLAN § C-3, § C-6). Mounted ONCE, internal only, like every admin router
 * since the Phase 5 cutover: do not add a public `/api/admin/*` mount — `requireRole(['admin'])`
 * would compile, work, and bypass wi-admin's tiers and audit.
 *
 * Writes only. wi-admin reads `listings` (and, behind `catalog.listings.contacts.read`,
 * `listing_contacts`) directly. Each write here pairs a transition with work a second writer
 * would miss: approve copies BOTH collections in one transaction and derives `available_fields`;
 * reject and the funding path move credits; suspend and unsuspend move the AI index.
 *
 * Wave 1 carries the four decisions. The reveal refund and the reveal blocks (§ C-3) are wave 2.
 */
function attachRoutes(router: Router): Router {
  router.post('/:id/approve', AdminListingController.approve);
  router.post('/:id/reject', AdminListingController.reject);
  router.post('/:id/suspend', AdminListingController.suspend);
  router.post('/:id/unsuspend', AdminListingController.unsuspend);
  return router;
}

/** Build the listing admin surface behind an arbitrary guard chain. */
export function buildAdminListingRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}
