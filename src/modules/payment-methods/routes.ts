import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { PaymentMethodController } from './controllers/payment-method.controller';

/**
 * Saved payment methods, shared across every user role. Mounted once at
 * `/api/me/payment-methods`; the owner is resolved from `req.auth`, so any
 * authenticated role can manage its own instruments.
 */
const router = Router();

router.use(requireAuth);

/** GET /api/me/payment-methods */
router.get('/', PaymentMethodController.list);

/** GET /api/me/payment-methods/default */
router.get('/default', PaymentMethodController.getDefault);

/** POST /api/me/payment-methods */
router.post('/', PaymentMethodController.add);

/** PATCH /api/me/payment-methods/:id/default */
router.patch('/:id/default', PaymentMethodController.setDefault);

/** DELETE /api/me/payment-methods/:id */
router.delete('/:id', PaymentMethodController.remove);

export default router;
