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
 * The ordinary reason (ADR-004 D-2), and here it is concrete: every moderation action
 * recomputes the affected aggregates and, for a delivery review, nudges that agent's
 * trust recompute — which after Step 11 moves their COD cash limit. A second writer
 * would flip `status` in the database and leave every one of those effects unfired,
 * silently. wi-admin reads `reviews` directly for its list; it calls in to act on one.
 *
 * ── Moderation is AFTER the fact (owner decision, 2026-10-05) ─────────────────
 * Every review publishes on submission. These verbs act on a review that is already
 * public. `publish` and `reject` — the old verdicts on a held review — are gone with
 * the held state. Unpublish and republish are deliberately a two-way toggle now: the
 * owner asked for it, and the audit trail stays unambiguous because wi-admin records
 * every action, before it is performed, with its actor.
 */
function attachRoutes(router: Router): Router {
  /**
   * GET / — every live review, **newest first**, every status unless filtered.
   * Filters: `status`, `subjectType`, `authorRole`, plus `page`/`limit`.
   */
  router.get('/', AdminReviewController.list);

  /** GET /:id — one live review, with the eligibility evidence attached. */
  router.get('/:id', AdminReviewController.getById);

  /** POST /:id/unpublish — body `{ reason }`, required. CAS on `published`; 409 on a miss. */
  router.post('/:id/unpublish', AdminReviewController.unpublish);

  /** POST /:id/republish — body `{ reason? }`. CAS on `unpublished`; 409 on a miss. */
  router.post('/:id/republish', AdminReviewController.republish);

  /**
   * DELETE /:id — body `{ reason }`, required. Any status; 404 if already deleted.
   * The author may write a new review of the same subject afterwards.
   */
  router.delete('/:id', AdminReviewController.remove);

  return router;
}

/** Build the review-moderation surface behind an arbitrary guard chain. */
export function buildAdminReviewRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}
