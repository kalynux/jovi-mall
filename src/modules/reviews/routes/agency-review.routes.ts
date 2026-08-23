import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { buildReviewController } from '../controllers/review.controller';

const router = Router();
const controller = buildReviewController('agency');

/**
 * Agency reviews — `/api/agency/reviews`. **Deliveries only.**
 *
 * The agency rates its own agent's run: this is the employer's supervision record,
 * and it closes the composite's `agency_rating` factor (weight 10).
 *
 * ⚠ **An agency's review moves the AGENT's aggregate and never its own.** An agency
 * rating itself is not evidence of anything, and it is the agency's own directory
 * score — publishing a self-report there would make the number a vendor reads when
 * choosing a delivery partner worthless. `targetsOf` encodes that: for
 * `author_role: 'agency'` the agency target is dropped. The agency's public rating
 * comes from its **customers'** delivery reviews instead.
 *
 * Identity flows token → agency. There is no agencyId in any path.
 */
router.use(requireAuth);
router.use(requireRole(['agency']));

/** POST /api/agency/reviews — `subjectType` must be `delivery`, on this agency's own shipment. */
router.post('/', controller.create);

/** GET /api/agency/reviews/eligibility?subjectType=delivery&subjectId=<shipmentId> */
router.get('/eligibility', controller.eligibility);

/** GET /api/agency/reviews — this agency's own reviews, every status. */
router.get('/', controller.list);

export default router;
