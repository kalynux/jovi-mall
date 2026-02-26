import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgencyProfileController } from './controllers/agency-profile.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

/** GET /api/agency/profile */
router.get('/profile', AgencyProfileController.getProfile);

/** PATCH /api/agency/profile */
router.patch('/profile', AgencyProfileController.updateProfile);

/** GET /api/agency/profile/completion-status */
router.get('/profile/completion-status', AgencyProfileController.getCompletionStatus);

/**
 * PATCH /api/agency/onboarding/step
 * Body: { step: 1 | 2 | 3, ...stepFields }
 *   Step 1: { coverage_areas[], headquarters_addresses[] (min 1; first = primary) }
 *   Step 2: { payout_details }
 *   Step 3: { skip?: boolean, logo_url?, timezone? }
 */
router.patch('/onboarding/step', AgencyProfileController.completeOnboardingStep);

export default router;
