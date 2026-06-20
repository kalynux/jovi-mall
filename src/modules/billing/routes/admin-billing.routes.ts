import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminBillingController } from '../controllers/admin-billing.controller';

/**
 * Admin billing routes — pricing plan catalog management and vendor assignment.
 * Mounted at `/api/admin` → `/admin/plans`, `/admin/vendors/:vendorId/plan`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

// Pricing plan catalog
router.get('/plans', AdminBillingController.listPlans);
router.post('/plans', AdminBillingController.createPlan);
router.patch('/plans/:id', AdminBillingController.updatePlan);
router.delete('/plans/:id', AdminBillingController.deletePlan);

// Assign a plan to a vendor (after confirming payment out of band)
router.post('/vendors/:vendorId/plan', AdminBillingController.assignPlanToVendor);

export default router;
