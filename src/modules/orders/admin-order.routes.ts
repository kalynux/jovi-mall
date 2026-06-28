import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminOrderController } from './admin-order.controller';

/**
 * Admin Order Routes
 *
 * Path: /api/admin/orders
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

// Orders frozen by a payment dispute.
router.get('/disputes', AdminOrderController.listDisputed);

// Manually resolve a dispute (won → resume, lost → refund + return/cancel).
router.post('/:id/dispute/resolve', AdminOrderController.resolveDispute);

export default router;
