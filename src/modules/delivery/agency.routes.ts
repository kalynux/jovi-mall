import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AgencyProfileController } from './controllers/agency-profile.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

// ─── Agency Creation ──────────────────────────────────────────────────────────

/**
 * POST /api/agency
 * Initialize agency onboarding (sets agency_name on existing doc).
 * Body: { agency_name: string }
 */
router.post('/', AgencyProfileController.createAgency);

// ─── Profile ──────────────────────────────────────────────────────────────────

/** GET /api/agency/profile */
router.get('/profile', AgencyProfileController.getProfile);

/** PATCH /api/agency/profile */
router.patch('/profile', AgencyProfileController.updateProfile);

// ─── Onboarding ───────────────────────────────────────────────────────────────

/**
 * GET /api/agency/onboarding/status
 * Full onboarding state: current step, progress %, completed/missing fields, warnings
 */
router.get('/onboarding/status', AgencyProfileController.getOnboardingStatus);

/**
 * PUT /api/agency/onboarding/logistics
 * Step 1 (Required): coverage_areas (min 1), headquarters_addresses (min 1; first = primary)
 * Optional: { updated_at } for optimistic concurrency
 */
router.put('/onboarding/logistics', AgencyProfileController.completeLogisticsSetup);

/**
 * PUT /api/agency/onboarding/payout
 * Step 2 (Required): payout_details
 * Optional: { updated_at } for optimistic concurrency
 */
router.put('/onboarding/payout', AgencyProfileController.completePayoutSetup);

/**
 * PUT /api/agency/onboarding/branding
 * Step 3 (Optional/Skippable): { skip?: boolean, logo_url?, timezone? }
 * Optional: { updated_at } for optimistic concurrency
 */
router.put('/onboarding/branding', AgencyProfileController.completeBrandingSetup);

/**
 * PUT /api/agency/onboarding/policies
 * Step 4 (Required): { policies: { pricing, returns, damage } }
 * Optional: { updated_at } for optimistic concurrency
 */
router.put('/onboarding/policies', AgencyProfileController.completePolicySetup);

// ─── Legacy / Backward Compatibility ──────────────────────────────────────────

/** GET /api/agency/profile/completion-status (kept for backward compat) */
router.get('/profile/completion-status', AgencyProfileController.getCompletionStatus);

export default router;
