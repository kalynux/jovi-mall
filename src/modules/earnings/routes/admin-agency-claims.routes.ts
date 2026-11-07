import { RequestHandler, Router } from 'express';
import { EarningsExplanationsController } from '../controllers/earnings-explanations.controller';

/**
 * `/api/internal/admin/agency-claims` — damage claims on an agency (owner F-8, 2026-10-22),
 * served to wi-admin only, behind `requireAdminCaller` (passed in as `guards`, the factory shape
 * every internal-admin router follows). Contract: `api-doc/admin/agency-claims.md`.
 *
 * The literal `/eligibility` is declared before `/:id`.
 */
export function buildAdminAgencyClaimRouter(guards: RequestHandler[] = []): Router {
  const router = Router();
  if (guards.length > 0) router.use(...guards);

  router.get('/', EarningsExplanationsController.adminList);
  router.get('/eligibility', EarningsExplanationsController.adminEligibility);
  router.get('/:id', EarningsExplanationsController.adminGet);
  router.post('/', EarningsExplanationsController.adminCreate);

  return router;
}
