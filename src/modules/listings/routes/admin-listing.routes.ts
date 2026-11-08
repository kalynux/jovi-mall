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
 * The four decisions, plus the lead-report writes (step 7): block / lift a customer here, and
 * the reveal refund on its own prefix (`buildAdminListingRevealRouter`, mounted at
 * `/listing-reveals`) because § C-3 names it by the reveal, not by the listing.
 */
function attachRoutes(router: Router): Router {
  router.post('/:id/approve', AdminListingController.approve);
  router.post('/:id/reject', AdminListingController.reject);
  router.post('/:id/suspend', AdminListingController.suspend);
  router.post('/:id/unsuspend', AdminListingController.unsuspend);
  router.post('/:id/reveal-blocks/:customerId', AdminListingController.blockCustomer);
  router.delete('/:id/reveal-blocks/:customerId', AdminListingController.liftBlock);
  return router;
}

/** Build the listing admin surface behind an arbitrary guard chain. */
export function buildAdminListingRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}

/** `/api/internal/admin/listing-reveals/:revealId/refund` — the reveal refund (L-25). */
export function buildAdminListingRevealRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  router.post('/:revealId/refund', AdminListingController.refundReveal);
  return router;
}
