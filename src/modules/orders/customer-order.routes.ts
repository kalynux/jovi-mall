import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CustomerOrderController } from './customer-order.controller';

/**
 * Customer Order Routes
 *
 * Path: /api/customer/orders
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

// Confirm delivery / satisfaction → completes the order, starts the escrow hold.
router.patch('/:id/confirm-delivery', CustomerOrderController.confirmDelivery);

// Cancel an unpaid, pre-shipment order (gated by the vendor's cancellation policy).
router.post('/:id/cancel', CustomerOrderController.cancelOrder);

export default router;
