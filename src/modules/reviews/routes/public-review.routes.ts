import { Router } from 'express';
import { PublicReviewController } from '../controllers/public-review.controller';

/**
 * Public reviews — mounted at `/api/public`, so `/public/products/:productId/reviews`.
 *
 * ⚠️ There is **no `requireAuth`** on this router, the same as the other four on that
 * prefix. Everything here is a read of something a moderator has deliberately
 * published, and nothing here reads `req.auth`.
 *
 * This is the **fourth** router on `/public`, after billing, blog and catalog. The
 * paths do not collide: catalog declares `/products` and `/products/:productId` and
 * nothing under them, and Express falls through a router when nothing in it matches.
 * Mount order in `api/index.ts` therefore does not matter here — but this router is
 * mounted **after** the catalog one anyway, so the more specific three-segment path
 * is reached by fall-through rather than by shadowing.
 */
const router = Router();

/**
 * GET /api/public/products/:productId/reviews
 *
 * Published product reviews, newest first, with `meta.rating` carrying the breakdown
 * — or `null` when there are none, which is what keeps `aggregateRating` out of the
 * storefront's JSON-LD until a real aggregate exists.
 *
 * ⚠ **Do not add a `subjectType` parameter.** Delivery reviews are an internal
 * quality signal naming an agent; only their aggregate leaves the platform.
 */
router.get('/products/:productId/reviews', PublicReviewController.listForProduct);

export default router;
