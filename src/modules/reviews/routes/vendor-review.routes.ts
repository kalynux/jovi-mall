import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { buildReviewController } from '../controllers/review.controller';

const router = Router();
const controller = buildReviewController('vendor');

/**
 * Vendor reviews — `/api/vendor/reviews`. **Deliveries only.**
 *
 * A vendor rates how their consignment was handled: collected on time, carried
 * intact, delivered to the right person. `roleMayReview` refuses them a product
 * review — that one belongs to the buyer, and a seller rating their own catalogue
 * is what verified-purchase gating exists to prevent.
 *
 * ── Why the vendor is a rating party at all ──────────────────────────────────
 * They are the one non-recipient who actually meets the agent: `vendor-order.service.ts`
 * puts the agent's name, phone and avatar on the vendor's order view, and the agent
 * collects from the vendor's own address. This closes the composite's `vendor_rating`
 * factor (weight 10), which has blended to the seed since the score existed.
 *
 * Identity flows token → vendor. There is no vendorId in any path.
 */
router.use(requireAuth);
router.use(requireRole(['vendor']));

/** POST /api/vendor/reviews — `subjectType` must be `delivery`. */
router.post('/', controller.create);

/** GET /api/vendor/reviews/eligibility?subjectType=delivery&subjectId=<shipmentId> */
router.get('/eligibility', controller.eligibility);

/** GET /api/vendor/reviews — this vendor's own reviews, every status. */
router.get('/', controller.list);

export default router;
