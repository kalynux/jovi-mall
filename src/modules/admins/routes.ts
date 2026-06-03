import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminProfileController } from './controllers/admin-profile.controller';
import { VendorProductController } from '../catalog/controllers/vendor-product.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

/** GET /api/admin/profile — returns self-profile including last_login_ip */
router.get('/profile', AdminProfileController.getProfile);

/** PATCH /api/admin/profile */
router.patch('/profile', AdminProfileController.updateProfile);

/**
 * POST /api/admin/products/bulk-vectorise
 * Trigger vectorisation for a specific set of products, or all eligible products.
 *
 * Body: { productIds?: string[] }
 *   - Provide productIds to target specific products.
 *   - Omit (or send empty array) to vectorise ALL eligible active products.
 *
 * This endpoint is synchronous and returns a summary: { succeeded, failed, total, errors }.
 * Use it for manual re-runs or after onboarding a new batch of products.
 */
router.post('/products/bulk-vectorise', VendorProductController.bulkVectorise);

export default router;

