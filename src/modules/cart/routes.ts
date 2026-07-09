import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CartController } from './controllers/cart.controller';

/**
 * Customer Cart Routes
 *
 * Path: /api/customer/cart
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

router.get('/', CartController.getCart);
router.post('/items', CartController.addItem);
router.delete('/items/:productId', CartController.removeItem);
router.delete('/', CartController.clearCart);

export default router;
