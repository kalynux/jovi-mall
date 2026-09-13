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
// Purchase history moved to the unified GET /vendor/transactions feed.
router.post('/plans/:planId/purchase', VendorBillingController.purchasePlan);
// Mobile-money OTP relay (My-CoolPay Orange Money answers `requiresOtp` at purchase).
// Owner-scoped, unlike the payments module's open /payments/:id/authorize — see
// billing/domain/gateway-otp.ts for why that asymmetry is deliberate.
router.post('/plan-purchases/:id/authorize', VendorBillingController.authorizePlanPurchase);
router.post('/plan-purchases/:id/verify', VendorBillingController.verifyPlanPurchase);

// Credits. History (ledger + top-ups) moved to GET /vendor/transactions.
router.get('/credits', VendorBillingController.getBalance);
router.get('/credits/packs', VendorBillingController.listTopupPacks);
router.post('/credits/topups', VendorBillingController.initiateTopup);
router.post('/credits/topups/:id/authorize', VendorBillingController.authorizeTopup);
router.post('/credits/topups/:id/verify', VendorBillingController.verifyTopup);

// Vendor settings (currently the plan-expiry notification preference)
router.get('/settings', VendorBillingController.getSettings);
router.patch('/settings', VendorBillingController.updateSettings);

export default router;
