import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgentBillingController } from '../controllers/agent-billing.controller';

/**
 * Agent billing routes — plan discovery, current plan, credit balance, top-up
 * purchases and settings. Mounted at `/api/agent` → `/agent/plans`,
 * `/agent/credits`, `/agent/settings`, etc. Mirrors the vendor surface.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

// Plans
router.get('/plans', AgentBillingController.listPlans);
router.get('/plan', AgentBillingController.getMyPlan);

// Self-serve plan purchase (auto-activates / queues on gateway confirmation)
router.post('/plans/:planId/purchase', AgentBillingController.purchasePlan);
router.post('/plan-purchases/:id/verify', AgentBillingController.verifyPlanPurchase);

// Credits
router.get('/credits', AgentBillingController.getBalance);
router.get('/credits/packs', AgentBillingController.listTopupPacks);
router.post('/credits/topups', AgentBillingController.initiateTopup);
router.post('/credits/topups/:id/verify', AgentBillingController.verifyTopup);

// Settings (plan-expiry notification preference)
router.get('/settings', AgentBillingController.getSettings);
router.patch('/settings', AgentBillingController.updateSettings);

export default router;
