import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorTransactionController } from '../controllers/vendor-transaction.controller';

/**
 * Vendor transactions routes. Mounted at `/api/vendor/transactions`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));

router.get('/', VendorTransactionController.list);

export default router;
