import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { ConnectionController } from '../controllers/connection.controller';

/**
 * Agency Vendor-Connection Routes
 *
 * Path: /api/agency/vendor-connections
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agency']));

router.post('/', ConnectionController.request);
router.get('/', ConnectionController.list);
router.get('/browse', ConnectionController.browseVendors);
router.get('/:id', ConnectionController.getById);
router.post('/:id/approve', ConnectionController.approve);
router.post('/:id/reject', ConnectionController.reject);
router.post('/:id/withdraw', ConnectionController.withdraw);
router.post('/:id/terminate', ConnectionController.terminate);

export default router;
