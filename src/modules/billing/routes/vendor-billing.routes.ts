import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorBillingController } from '../controllers/vendor-billing.controller';

/**
 * Vendor billing routes — plan discovery, current plan, credit balance/ledger,
 * top-up purchases and settings. Mounted at `/api/vendor` → `/vendor/plans`,
 * `/vendor/credits`, `/vendor/settings`, etc.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

// Plans
router.get('/plans', VendorBillingController.listPlans);
router.get('/plan', VendorBillingController.getMyPlan);

// Self-serve plan purchase (auto-activates / queues on gateway confirmation)
router.get('/plan-purchases', VendorBillingController.listPlanPurchases);
router.post('/plans/:planId/purchase', VendorBillingController.purchasePlan);
router.post('/plan-purchases/:id/verify', VendorBillingController.verifyPlanPurchase);

// Credits
router.get('/credits', VendorBillingController.getBalance);
router.get('/credits/ledger', VendorBillingController.getLedger);
router.get('/credits/packs', VendorBillingController.listTopupPacks);
router.get('/credits/topups', VendorBillingController.listTopups);
router.post('/credits/topups', VendorBillingController.initiateTopup);
router.post('/credits/topups/:id/verify', VendorBillingController.verifyTopup);

// Vendor settings (currently the plan-expiry notification preference)
router.get('/settings', VendorBillingController.getSettings);
router.patch('/settings', VendorBillingController.updateSettings);

export default router;
