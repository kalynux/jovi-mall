import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { VendorTransactionController } from '../controllers/vendor-transaction.controller';

/**
 * Vendor transactions routes. Mounted at `/api/vendor/transactions`.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));
// Vendor kind (SERVICE-LISTINGS-PLAN § C-1): BOTH — a provider has a transaction history (credit movements only — they earn nothing through Wi-Mall).
router.use(requireVendorKind('both'));

router.get('/', VendorTransactionController.list);

export default router;
