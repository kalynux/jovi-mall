import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgencyBillingController } from '../controllers/agency-billing.controller';

/**
 * Agency billing routes — plan discovery, current plan, credit balance, top-up
 * purchases and settings. Mounted at `/api/agency` → `/agency/plans`,
 * `/agency/credits`, `/agency/settings`, etc. Mirrors the vendor surface.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

// Plans
router.get('/plans', AgencyBillingController.listPlans);
router.get('/plan', AgencyBillingController.getMyPlan);

// Self-serve plan purchase (auto-activates / queues on gateway confirmation)
router.post('/plans/:planId/purchase', AgencyBillingController.purchasePlan);
router.post('/plan-purchases/:id/verify', AgencyBillingController.verifyPlanPurchase);

// Credits
router.get('/credits', AgencyBillingController.getBalance);
router.get('/credits/packs', AgencyBillingController.listTopupPacks);
router.post('/credits/topups', AgencyBillingController.initiateTopup);
router.post('/credits/topups/:id/verify', AgencyBillingController.verifyTopup);

// Settings (plan-expiry notification preference)
router.get('/settings', AgencyBillingController.getSettings);
router.patch('/settings', AgencyBillingController.updateSettings);

export default router;
