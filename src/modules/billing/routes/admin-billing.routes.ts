import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminBillingController } from '../controllers/admin-billing.controller';

/**
 * Admin billing routes — pricing plan catalog management (any role) and plan
 * assignment to a vendor / agency / agent. Mounted at `/api/admin` →
 * `/admin/plans?role=`, `/admin/vendors|agencies|agents/:id/plan`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

// Pricing plan catalog (all roles; filter with ?role=vendor|agency|agent)
router.get('/plans', AdminBillingController.listPlans);
router.post('/plans', AdminBillingController.createPlan);
router.patch('/plans/:id', AdminBillingController.updatePlan);
router.delete('/plans/:id', AdminBillingController.deletePlan);

// Assign a plan to an owner (after confirming payment out of band)
router.post('/vendors/:vendorId/plan', AdminBillingController.assignPlanToVendor);
router.post('/agencies/:agencyId/plan', AdminBillingController.assignPlanToAgency);
router.post('/agents/:agentId/plan', AdminBillingController.assignPlanToAgent);

export default router;
