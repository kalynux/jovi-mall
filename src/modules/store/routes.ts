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
router.get('/', StoreProfileController.getStore);

/**
 * PATCH /api/vendor/store
 * 
 * Update authenticated vendor's store profile
 * 
 * Body: {
 *   name?, logoFileId?, bannerFileId?, description?,
 *   supportEmail?, supportPhone?, supportWhatsapp?,
 *   version
 * }
 * logoFileId/bannerFileId are ids of files uploaded via POST /api/files/upload
 * ('' or null clears the slot). The response returns the resolved `logo`/`banner`
 * file objects ({ id, key, url, mimeType, size, originalName } | null).
 *
 * NOT allowed: slug (immutable). Addresses/country live on the vendor
 * profile (business_addresses + set-once country), not on the store.
 */
router.patch('/', StoreProfileController.updateStore);

/**
 * PATCH /api/vendor/store/status
 * 
 * Toggle store vacation mode
 * 
 * Body: { isOpen, version }
 */
router.patch('/status', StoreProfileController.updateStoreStatus);

export default router;
