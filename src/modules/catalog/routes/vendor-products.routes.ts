import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { uploadSingle } from '../../../api/middlewares/upload.middleware';
import { VendorProductController } from '../controllers/vendor-product.controller';
import { VendorDigitalAssetController } from '../controllers/vendor-digital-asset.controller';
import { VendorServiceCalendarController } from '../controllers/vendor-service-calendar.controller';

const router = Router();

/**
 * Vendor Product Management Routes
 * 
 * All routes require authentication and vendor role.
 * Vendor can only access/modify their own products.
 * 
 * CRITICAL: No productId-based access control needed in routes.
 * Identity flow: token → vendor → products (filtered by vendorId in services)
 */

// Apply authentication to all routes
router.use(requireAuth);
router.use(requireRole(['vendor']));

/**
 * ==========================================
 * PRODUCT CRUD OPERATIONS
 * ==========================================
 */

/**
 * GET /api/vendor/products
 * List products with filters, search, and sorting
 * 
 * Query params:
 * - type: physical | digital | service
 * - status: draft | active | archived
 * - q: search text
 * - sortBy: createdAt | updatedAt | title
 * - sortOrder: asc | desc
 * - page: number
 * - limit: number
 */
router.get('/', VendorProductController.listProducts);

/**
 * POST /api/vendor/products
 * Create a new product (starts in draft status)
 * 
 * Body: {
 *   type,
 *   title,
 *   description?,
 *   seoTitle?,
 *   seoDescription?,
 *   digitalConfig?,
 *   serviceConfig?
 * }
 */
router.post('/', VendorProductController.createProduct);

/**
 * GET /api/vendor/products/:id
 * Get a single product
 */
router.get('/:id', VendorProductController.getProduct);

/**
 * PATCH /api/vendor/products/:id
 * Update a product
 * 
 * Body: {
 *   title?,
 *   description?,
 *   images?, // NOTE: Full array replacement
 *   seoTitle?,
 *   seoDescription?,
 *   digitalConfig?,
 *   serviceConfig?
 * }
 */
router.patch('/:id', VendorProductController.updateProduct);

/**
 * PATCH /api/vendor/products/:id/status
 * Change product status
 * 
 * Body: { status }
 * 
 * Validation rules:
 * - Cannot activate digital product without asset
 * - Cannot activate service product without duration
 */
router.patch('/:id/status', VendorProductController.changeStatus);

/**
 * POST /api/vendor/products/:id/duplicate
 * Duplicate a product
 * 
 * Creates a copy with:
 * - status = draft
 * - title = "Original title (copy)"
 * - slug = intelligent collision prevention (original-slug-copy, -copy-2, etc.)
 */
router.post('/:id/duplicate', VendorProductController.duplicateProduct);

/**
 * DELETE /api/vendor/products/:id
 * Archive a product (soft delete)
 * 
 * Sets status to 'archived'
 */
router.delete('/:id', VendorProductController.archiveProduct);

/**
 * ==========================================
 * BULK OPERATIONS
 * ==========================================
 */

/**
 * POST /api/vendor/products/bulk/archive
 * Bulk archive products
 * 
 * Body: {
 *   productIds: string[]
 * }
 */
router.post('/bulk/archive', VendorProductController.bulkArchive);

/**
 * POST /api/vendor/products/bulk/status
 * Bulk status change
 * 
 * Body: {
 *   productIds: string[],
 *   status: string
 * }
 * 
 * NOTE: Uses validation if status is 'active'
 */
router.post('/bulk/status', VendorProductController.bulkStatusChange);

/**
 * ==========================================
 * DIGITAL PRODUCT MANAGEMENT
 * ==========================================
 */

/**
 * POST /api/vendor/products/:id/digital/asset
 * Upload digital asset
 * 
 * Multipart form-data with file field named "file"
 * 
 * Transactional upload with rollback on failure
 * File size and mime type validation applied
 */
router.post('/:id/digital/asset', uploadSingle, VendorDigitalAssetController.uploadAsset);

/**
 * PUT /api/vendor/products/:id/digital/asset
 * Replace digital asset
 * 
 * Multipart form-data with file field named "file"
 * 
 * Atomically replaces old asset with new one
 * Old asset is deleted after successful upload
 */
router.put('/:id/digital/asset', uploadSingle, VendorDigitalAssetController.replaceAsset);

/**
 * DELETE /api/vendor/products/:id/digital/asset
 * Remove digital asset
 * 
 * Unlinks asset from product and marks for deletion
 */
router.delete('/:id/digital/asset', VendorDigitalAssetController.removeAsset);

/**
 * PATCH /api/vendor/products/:id/digital/toggle
 * Toggle digital asset availability
 * 
 * Quick enable/disable without full product update
 * Useful for temporarily blocking downloads
 */
router.patch('/:id/digital/toggle', VendorDigitalAssetController.toggleAvailability);

/**
 * ==========================================
 * VARIANT MANAGEMENT (Physical Products)
 * ==========================================
 */

import { VendorVariantController } from '../controllers/vendor-variant.controller';

/**
 * POST /api/vendor/products/:id/variants
 * Create a new variant
 * 
 * Body: {
 *   sku, price, compareAtPrice?, stock, isInfiniteStock,
 *   weight?, length?, width?, height?,
 *   optionValueIds?
 * }
 */
router.post('/:id/variants', VendorVariantController.createVariant);

/**
 * GET /api/vendor/products/:id/variants
 * List all variants for a product
 * 
 * Query: status?, page?, limit?
 */
router.get('/:id/variants', VendorVariantController.listVariants);

/**
 * GET /api/vendor/products/:productId/variants/:variantId
 * Get a single variant
 */
router.get('/:productId/variants/:variantId', VendorVariantController.getVariant);

/**
 * PATCH /api/vendor/products/:productId/variants/:variantId
 * Update a variant
 * 
 * Body: partial variant updates
 */
router.patch('/:productId/variants/:variantId', VendorVariantController.updateVariant);

/**
 * DELETE /api/vendor/products/:productId/variants/:variantId
 * Archive a variant (soft delete)
 */
router.delete('/:productId/variants/:variantId', VendorVariantController.archiveVariant);

/**
 * ==========================================
 * SHIPPING CONFIGURATION (Physical Products)
 * ==========================================
 */

import { VendorShippingController } from '../controllers/vendor-shipping.controller';

/**
 * POST /api/vendor/products/:id/shipping
 * Create or update shipping configuration
 * 
 * Body: {
 *   weight, length, width, height, 
 *   originZipCode, handlingDays, shippingEnabled
 * }
 */
router.post('/:id/shipping', VendorShippingController.upsertShippingConfig);

/**
 * GET /api/vendor/products/:id/shipping
 * Get shipping configuration
 */
router.get('/:id/shipping', VendorShippingController.getShippingConfig);

/**
 * DELETE /api/vendor/products/:id/shipping
 * Delete shipping configuration
 */
router.delete('/:id/shipping', VendorShippingController.deleteShippingConfig);

/**
 * ==========================================
 * AVAILABILITY RULES (Service Products)
 * ==========================================
 */

import { VendorAvailabilityController } from '../../booking/controllers/vendor-availability.controller';

/**
 * POST /api/vendor/products/:id/availability-rules
 * Create availability rule (starts as draft)
 */
router.post('/:id/availability-rules', VendorAvailabilityController.createRule);

/**
 * GET /api/vendor/products/:id/availability-rules
 * List availability rules
 */
router.get('/:id/availability-rules', VendorAvailabilityController.listRules);

/**
 * PATCH /api/vendor/availability-rules/:ruleId
 * Update availability rule
 */
router.patch('/availability-rules/:ruleId', VendorAvailabilityController.updateRule);

/**
 * PATCH /api/vendor/availability-rules/:ruleId/activate
 * Activate (publish) availability rule
 */
router.patch('/availability-rules/:ruleId/activate', VendorAvailabilityController.activateRule);

/**
 * DELETE /api/vendor/availability-rules/:ruleId
 * Delete availability rule
 */
router.delete('/availability-rules/:ruleId', VendorAvailabilityController.deleteRule);

/**
 * ==========================================
 * SERVICE PRODUCT MANAGEMENT
 * ==========================================
 */

/**
 * GET /api/vendor/products/:id/service/calendar-status
 * Get calendar integration status
 * 
 * STUB: Returns placeholder response
 * Future integration point for Google Calendar sync
 */
router.get('/:id/service/calendar-status', VendorServiceCalendarController.getCalendarStatus);

export default router;
