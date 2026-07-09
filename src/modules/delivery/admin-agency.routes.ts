import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminAgencyController } from './controllers/admin-agency.controller';

/**
 * Admin delivery agency management routes.
 * Mounted at `/api/admin` → `/admin/delivery-agencies`.
 *
 * Deactivating an agency suspends every vendor's physical products (any status) where
 * that agency is currently their default delivery agency; reactivating restores them.
 * See AdminAgencyService.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

router.get('/delivery-agencies', AdminAgencyController.list);
router.get('/delivery-agencies/:id', AdminAgencyController.getById);
router.patch('/delivery-agencies/:id/deactivate', AdminAgencyController.deactivate);
router.patch('/delivery-agencies/:id/reactivate', AdminAgencyController.reactivate);

export default router;
