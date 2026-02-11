import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { StoreProfileController } from './controller/store-profile.controller';

const router = Router();

/**
 * Store Profile Routes
 * 
 * All routes require authentication and vendor role.
 * Vendor can only access/modify their own store.
 * 
 * CRITICAL: No storeId in routes. Identity flow: token → vendor → store.
 */

// Apply authentication to all routes
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * GET /api/vendor/store
 * 
 * Get authenticated vendor's store profile
 */
router.get('/store', StoreProfileController.getStore);

/**
 * PATCH /api/vendor/store
 * 
 * Update authenticated vendor's store profile
 * 
 * Body: {
 *   name?, logoUrl?, bannerUrl?, description?,
 *   address?, city?, supportEmail?, supportPhone?, supportWhatsapp?,
 *   version
 * }
 * 
 * NOT allowed: slug, country (immutable)
 */
router.patch('/store', StoreProfileController.updateStore);

/**
 * PATCH /api/vendor/store/status
 * 
 * Toggle store vacation mode
 * 
 * Body: { isOpen, version }
 */
router.patch('/store/status', StoreProfileController.updateStoreStatus);

export default router;
