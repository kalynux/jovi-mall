import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CustomerProfileController } from './controllers/customer-profile.controller';

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

/** PATCH /api/customer/addresses/:id/default */
router.patch('/addresses/:id/default', CustomerProfileController.setDefaultAddress);

/** POST /api/customer/payment-methods */
router.post('/payment-methods', CustomerProfileController.addPaymentMethod);

/** DELETE /api/customer/payment-methods/:id */
router.delete('/payment-methods/:id', CustomerProfileController.removePaymentMethod);

export default router;
