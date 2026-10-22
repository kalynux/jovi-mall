import { Router } from 'express';
import { PublicListingController } from '../controllers/public-listing.controller';

/**
 * `/api/public/listings*` — published service listings, world-readable
 * (SERVICE-LISTINGS-PLAN § C-3 "Public", L-26).
 *
 * ⚠ Anything under `/public` is readable by anyone with no further review. This router serves
 * only `listings.published` through the ONE visibility predicate
 * (`domain/public-listing.filter.ts`) and explicit DTOs carrying no contact value, no vendor id
 * and no pin. A contact is reached by a signed-in customer's REVEAL (wave 2), never from here.
 *
 * `by-ids` is declared before `:slug` so it is not read as a slug.
 */
const router = Router();

router.get('/listings', PublicListingController.list);
router.get('/listings/by-ids', PublicListingController.byIds);
router.get('/listings/:slug', PublicListingController.bySlug);

export default router;
