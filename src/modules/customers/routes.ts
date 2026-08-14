import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CustomerProfileController } from './controllers/customer-profile.controller';
import { DeviceTokenController } from '../notifications/controllers/device-token.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

/** GET /api/customer/profile */
router.get('/profile', CustomerProfileController.getProfile);

/** PATCH /api/customer/profile */
router.patch('/profile', CustomerProfileController.updateProfile);

/** GET /api/customer/profile/completion-status */
router.get('/profile/completion-status', CustomerProfileController.getCompletionStatus);

/** POST /api/customer/addresses */
router.post('/addresses', CustomerProfileController.addAddress);

/** DELETE /api/customer/addresses/:id */
router.delete('/addresses/:id', CustomerProfileController.removeAddress);

/**
 * PATCH /api/customer/addresses/:id/default
 *
 * ⚠️ Declared BEFORE `/addresses/:id`. Express matches in declaration order and these two
 * share a prefix; reversed, `PATCH /addresses/abc/default` would never be reached because
 * the shorter pattern does not match it — but the reverse hazard is real for any future
 * literal added under `/addresses/:id/`, so the ordering is kept explicit.
 */
router.patch('/addresses/:id/default', CustomerProfileController.setDefaultAddress);

/**
 * PATCH /api/customer/addresses/:id — edit a saved address in place.
 *
 * Before this, editing meant delete + re-add, which mints a **new** `_id` while past orders
 * still reference the old one through `deliveryAddressId`. Editing in place is what keeps
 * that reference meaningful.
 */
router.patch('/addresses/:id', CustomerProfileController.updateAddress);

/**
 * Push-notification device registration.
 *
 * `DeviceTokenController` is role-agnostic — it keys on `req.auth.user._id`, not on any role
 * entity — and is already mounted identically for vendor, agency and agent. The customer
 * mount was simply missing, which meant the customer notification catalog's promise of push
 * "to every device the customer has registered" was a promise to nobody: `FcmPushService`
 * resolved tokens by user and always found none.
 *
 * Not to be confused with `/api/agent/device` (singular) — that is an agent's device
 * *capabilities* and location permission, a different concept on an adjacent path.
 */
router.post('/devices', DeviceTokenController.register);
router.delete('/devices', DeviceTokenController.unregister);

/** POST /api/customer/payment-methods */
router.post('/payment-methods', CustomerProfileController.addPaymentMethod);

/** DELETE /api/customer/payment-methods/:id */
router.delete('/payment-methods/:id', CustomerProfileController.removePaymentMethod);

export default router;
