import { RequestHandler, Router } from 'express';
import { AdminReviewController } from '../controllers/admin-review.controller';

/**
 * Review moderation, for wi-admin.
 *
 * Mounted ONCE, at `/api/internal/admin/reviews`, behind `requireAdminCaller`. The
 * factory shape is the house pattern (`admin-agency.routes.ts`, `admin-cod.routes.ts`)
 * and is kept here even with a single mount for the reason those files give: a single
 * Router instance cannot be mounted twice without re-running its own guards, and the
 * factory is what made the Phase 5 cutover subtractive rather than a rewrite.
 *
 * ⚠ **Do not add a public instantiation.** `requireRole(['admin'])` still exists and
 * still guards the vendor, agency, agent and customer routers, so writing one would
 * compile and work — and would reopen the second authorization model Phase 5 closed.
 *
 * ── Why moderation is delegated rather than done in wi-admin ─────────────────
 * The ordinary reason (ADR-004 D-2), and here it is concrete: a moderation verdict
 * recomputes the affected aggregates and, for a delivery review, nudges that agent's
 * trust recompute — which after Step 11 moves their COD cash limit. A second writer
 * would flip `status` in the database and leave every one of those effects unfired,
 * silently. wi-admin reads `reviews` directly if it wants a report; it calls in to
 * decide one.
 */
function attachRoutes(router: Router): Router {
  /**
   * GET / — the queue. Defaults to `pending`, **oldest first**.
   * Filters: `status`, `subjectType`, `authorRole`, plus `page`/`limit`.
   */
  router.get('/', AdminReviewController.list);

  /** GET /:id — one review, with the eligibility evidence attached. */
  router.get('/:id', AdminReviewController.getById);

  /**
   * POST /:id/publish — a compare-and-set on `pending`; 409 on a miss.
   * Publishing recomputes every aggregate the review contributes to.
   */
  router.post('/:id/publish', AdminReviewController.publish);

  /**
   * POST /:id/reject — body `{ reason }`, required.
   *
   * The rejected review counts for nothing afterwards, star included. There is
   * deliberately no un-reject: re-review is not a thing a moderation verdict offers,
   * and a two-way toggle makes the audit trail ambiguous about what was ever live.
   */
  router.post('/:id/reject', AdminReviewController.reject);

  return router;
}

/** Build the review-moderation surface behind an arbitrary guard chain. */
export function buildAdminReviewRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}
