import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AdminPayoutRequestsController } from '../controllers/admin-payout-requests.controller';

/**
 * Admin payout-request routes. Mounted at `/api/admin` → `/admin/payout-requests`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

router.get('/payout-requests', AdminPayoutRequestsController.list);
router.get('/payout-requests/:id', AdminPayoutRequestsController.getById);
router.post('/payout-requests/:id/mark-paid', AdminPayoutRequestsController.markPaid);
router.post('/payout-requests/:id/reject', AdminPayoutRequestsController.reject);

export default router;
