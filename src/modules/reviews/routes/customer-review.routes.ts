import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { buildReviewController } from '../controllers/review.controller';

const router = Router();
const controller = buildReviewController('customer');

/**
 * Customer reviews — `/api/customer/reviews`.
 *
 * The one router of the three that may write a **product** review: a product review
 * is the buyer's, and eligibility is a completed order containing that item. The same
 * router also carries the customer's **delivery** review, which rates the shipment
 * they received.
 *
 * ⚠ A delivery review is attributed to the agent who carried it — **server-side**.
 * The customer never learns which agent that was; `orders/dto/customer-shipment.dto.ts`
 * withholds the agent's identity deliberately, and this endpoint does not undo that.
 * They rate the delivery; the platform knows whose it was.
 *
 * Identity flows token → customer. There is no customerId in any path.
 */
router.use(requireAuth);
router.use(requireRole(['customer']));

/**
 * POST /api/customer/reviews
 *
 * Body: `{ subjectType: 'product' | 'delivery', subjectId, rating, title?, body? }`.
 * A bare rating publishes immediately; one carrying text is held for moderation —
 * see `initialStatusOf`. The response says which happened, in `status`.
 */
router.post('/', controller.create);

/**
 * GET /api/customer/reviews/eligibility?subjectType=&subjectId=
 *
 * Declared BEFORE nothing and after nothing that could shadow it — there is no
 * `/:id` route on this router, so the literal cannot be captured by a param. It is
 * nonetheless the first GET for readability.
 */
router.get('/eligibility', controller.eligibility);

/** GET /api/customer/reviews — this customer's own reviews, every status. */
router.get('/', controller.list);

export default router;
