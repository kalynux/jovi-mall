import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';
import { ConnectionController } from '../controllers/connection.controller';

/**
 * Vendor Agency-Connection Routes
 *
 * Path: /api/vendor/agency-connections
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['vendor']));
// Vendor kind (SERVICE-LISTINGS-PLAN § C-1): SELLER — delivery-agency links — a provider ships nothing.
router.use(requireVendorKind('seller'));

router.post('/', ConnectionController.request);
router.get('/', ConnectionController.list);
router.get('/browse', ConnectionController.browseAgencies);
router.get('/:id', ConnectionController.getById);
router.post('/:id/approve', ConnectionController.approve);
router.post('/:id/reject', ConnectionController.reject);
router.post('/:id/withdraw', ConnectionController.withdraw);
router.post('/:id/terminate', ConnectionController.terminate);

export default router;
