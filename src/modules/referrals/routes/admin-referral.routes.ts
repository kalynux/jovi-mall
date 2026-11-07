import { RequestHandler, Router } from 'express';
import { AdminReferralController } from '../controllers/admin-referral.controller';

/**
 * Referral administration, the surface wi-admin delegates to (`/api/internal/admin/referrals`,
 * REFERRAL-PROGRAM-PLAN § 5.9). Mounted ONCE, internal only, like every admin router since the
 * Phase 5 cutover: do not add a public `/api/admin/*` mount.
 *
 * Every route is a write. wi-admin reads `referral_*` directly.
 */
function attachRoutes(router: Router): Router {
  router.patch('/settings', AdminReferralController.updateSettings);

  router.post('/partners/:partnerId/approve', AdminReferralController.approve);
  router.post('/partners/:partnerId/reject', AdminReferralController.reject);
  router.post('/partners/:partnerId/suspend', AdminReferralController.suspend);
  router.post('/partners/:partnerId/reinstate', AdminReferralController.reinstate);
  router.post('/partners/:partnerId/terminate', AdminReferralController.terminate);
  router.post('/partners/:partnerId/allow-reapply', AdminReferralController.allowReapply);
  router.post('/partners/:partnerId/release-balance', AdminReferralController.releaseBalance);
  router.patch('/partners/:partnerId/terms', AdminReferralController.updateTerms);
  return router;
}

/** Build the referral admin surface behind an arbitrary guard chain. */
export function buildAdminReferralRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}
