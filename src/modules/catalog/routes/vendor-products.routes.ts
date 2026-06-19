import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { uploadSingle } from '../../../api/middlewares/upload.middleware';
import { VendorProductController } from '../controllers/vendor-product.controller';
import { VendorDigitalAssetController } from '../controllers/vendor-digital-asset.controller';
import { VendorServiceCalendarController } from '../controllers/vendor-service-calendar.controller';
import { requireProductEditable } from '../middlewares/require-product-editable.middleware';

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
router.patch('/:id', requireProductEditable, VendorProductController.updateProduct);

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
router.patch('/:id/status', requireProductEditable, VendorProductController.changeStatus);

/**
 * PATCH /api/vendor/products/:id/default-variant
 * Set the default variant for display and pricing
 *
 * Body: { variantId: string }
 *
 * The default variant is auto-set to the first created variant.
 * Use this endpoint to manually reassign it.
 */
router.patch('/:id/default-variant', requireProductEditable, VendorProductController.setDefaultVariant);

/**
 * POST /api/vendor/products/:id/duplicate
 * Duplicate a product
 * 
 * Creates a copy with:
 * - status = draft
 * - title = "Original title (copy)"
 * - slug = intelligent collision prevention (original-slug-copy, -copy-2, etc.)
 */
router.post('/:id/duplicate', requireProductEditable, VendorProductController.duplicateProduct);

/**
 * DELETE /api/vendor/products/:id
 * Archive a product (soft delete)
 * 
 * Sets status to 'archived'
 */
router.delete('/:id', requireProductEditable, VendorProductController.archiveProduct);

/**
 * ==========================================
 * VECTORISATION (per product)
 * ==========================================
 */

/**
 * GET /api/vendor/products/:id/vectorisation/status
 * Read the current vectorisation snapshot for a product.
 */
router.get('/:id/vectorisation/status', VendorProductController.getVectorisationStatus);

/**
 * PATCH /api/vendor/products/:id/vectorisation
 * Set the vectorisation opt-in state for quick toggles.
 *
 * Body: { enabled: boolean }
 *
 * Idempotent — passing the current state returns 200 with a no-op message.
 * For state changes that produce side effects, responds 202 and runs the
 * upstream call (enable→vectorise, disable→delete) after the response.
 *
 * Vendors can also toggle this field as part of PATCH /:id (the regular
 * product update); this dedicated route exists for quick toggles only.
 *
 * Blocked while vectorisationStatus === 'pending'.
 */
router.patch('/:id/vectorisation', requireProductEditable, VendorProductController.setVectorisation);

/**
 * POST /api/vendor/products/:id/vectorisation/retry
 * Resubmit the full payload to the vectoriser (fire-and-forget).
 *
 * Blocked while vectorisationStatus === 'pending'.
 */
router.post('/:id/vectorisation/retry', requireProductEditable, VendorProductController.retryVectorisation);

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
 * DIGITAL ASSET MANAGEMENT (per variant)
 * ==========================================
 * Assets are owned per-variant — a digital product can have up to 5 variants,
 * each with its own asset, price, SKU, name, maxDownloads, and expiresAfterDays.
 * A digital variant is `status: 'active'` iff it has an asset uploaded.
 */

/**
 * POST /api/vendor/products/:productId/variants/:variantId/digital/asset
 * Upload a digital asset for a specific variant.
 *
 * Multipart form-data with file field named "file".
 * Rejects if the variant already has an asset (use PUT to replace).
 * On success, the variant transitions to `status: 'active'`.
 */
router.post(
    '/:productId/variants/:variantId/digital/asset',
    requireProductEditable,
    uploadSingle,
    VendorDigitalAssetController.uploadAsset,
);

/**
 * PUT /api/vendor/products/:productId/variants/:variantId/digital/asset
 * Replace the existing digital asset on a variant. Old asset is deleted after
 * successful upload. The variant stays `status: 'active'`.
 */
router.put(
    '/:productId/variants/:variantId/digital/asset',
    requireProductEditable,
    uploadSingle,
    VendorDigitalAssetController.replaceAsset,
);

/**
 * DELETE /api/vendor/products/:productId/variants/:variantId/digital/asset
 * Remove the digital asset from a variant. The variant becomes `status: 'archived'`
 * (digital variants cannot be active without an asset).
 */
router.delete(
    '/:productId/variants/:variantId/digital/asset',
    requireProductEditable,
    VendorDigitalAssetController.removeAsset,
);

/**
 * PATCH /api/vendor/products/:productId/variants/:variantId/digital/config
 * Update download limits (maxDownloads, expiresAfterDays) for a variant.
 * Body: { maxDownloads?: number|null, expiresAfterDays?: number|null }
 */
router.patch(
    '/:productId/variants/:variantId/digital/config',
    requireProductEditable,
    VendorDigitalAssetController.updateDigitalConfig,
);

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
router.post('/:id/variants', requireProductEditable, VendorVariantController.createVariant);

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
router.patch('/:productId/variants/:variantId', requireProductEditable, VendorVariantController.updateVariant);

/**
 * PATCH /api/vendor/products/:productId/variants/:variantId/service/config
 * Update the service variant's scheduling + peak-hours config (service products only).
 * Body: partial { durationMinutes?, bufferBeforeMinutes?, bufferAfterMinutes?, bookingMode?, peakHours?|null }
 */
router.patch(
    '/:productId/variants/:variantId/service/config',
    requireProductEditable,
    VendorVariantController.updateServiceConfig,
);

/**
 * PATCH /api/vendor/products/:productId/variants/:variantId/status
 * Toggle variant between active and archived (e.g. vendor temporarily disabling
 * a variant during a stock shortage). Activation enforces the same rules as
 * promoting the product to active (price > 0, digital variants require an asset).
 *
 * Body: { status: 'active' | 'archived' }
 */
router.patch(
    '/:productId/variants/:variantId/status',
    requireProductEditable,
    VendorVariantController.changeStatus,
);

/**
 * DELETE /api/vendor/products/:productId/variants/:variantId
 * Archive a variant (soft delete)
 */
router.delete('/:productId/variants/:variantId', requireProductEditable, VendorVariantController.archiveVariant);

/**
 * ==========================================
 * PRODUCT OPTIONS (Physical Products)
 * ==========================================
 */

import { VendorOptionController } from '../controllers/vendor-option.controller';

/**
 * POST /api/vendor/products/:productId/options
 * Create a new option for a product
 * 
 * Body: { name, position? }
 */
router.post('/:productId/options', requireProductEditable, VendorOptionController.createOption);

/**
 * GET /api/vendor/products/:productId/options
 * List all options for a product
 */
router.get('/:productId/options', VendorOptionController.listOptions);

/**
 * PATCH /api/vendor/products/:productId/options/:optionId
 * Update an option
 * 
 * Body: { name?, position? }
 */
router.patch('/:productId/options/:optionId', requireProductEditable, VendorOptionController.updateOption);

/**
 * PUT /api/vendor/products/:productId/options/reorder
 * Reorder options
 * 
 * Body: { optionIds: string[] }
 */
router.put('/:productId/options/reorder', requireProductEditable, VendorOptionController.reorderOptions);

/**
 * DELETE /api/vendor/products/:productId/options/:optionId
 * Delete an option (cascade deletes its values)
 */
router.delete('/:productId/options/:optionId', requireProductEditable, VendorOptionController.deleteOption);

/**
 * POST /api/vendor/products/:productId/options/:optionId/values
 * Create a single option value
 * 
 * Body: { value }
 */
router.post('/:productId/options/:optionId/values', requireProductEditable, VendorOptionController.createOptionValue);

/**
 * POST /api/vendor/products/:productId/options/:optionId/values/bulk
 * Bulk create option values
 * 
 * Body: { values: string[] }
 */
router.post('/:productId/options/:optionId/values/bulk', requireProductEditable, VendorOptionController.bulkCreateOptionValues);

/**
 * GET /api/vendor/products/:productId/options/:optionId/values
 * List all values for an option
 */
router.get('/:productId/options/:optionId/values', VendorOptionController.listOptionValues);

/**
 * PATCH /api/vendor/products/:productId/options/:optionId/values/:valueId
 * Rename an option value
 * 
 * Body: { value: "New Value" }
 * 
 * Safe operation — does not affect variant optionValueIds or optionSignature.
 */
router.patch('/:productId/options/:optionId/values/:valueId', requireProductEditable, VendorOptionController.updateOptionValue);

/**
 * DELETE /api/vendor/products/:productId/options/:optionId/values/:valueId
 * Delete an option value
 */
router.delete('/:productId/options/:optionId/values/:valueId', requireProductEditable, VendorOptionController.deleteOptionValue);


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
router.post('/:id/shipping', requireProductEditable, VendorShippingController.upsertShippingConfig);

/**
 * GET /api/vendor/products/:id/shipping
 * Get shipping configuration
 */
router.get('/:id/shipping', VendorShippingController.getShippingConfig);

/**
 * DELETE /api/vendor/products/:id/shipping
 * Delete shipping configuration
 */
router.delete('/:id/shipping', requireProductEditable, VendorShippingController.deleteShippingConfig);

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
router.post('/:id/availability-rules', requireProductEditable, VendorAvailabilityController.createRule);

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
 * PATCH /api/vendor/availability-rules/:ruleId/toggle
 * Set availability rule active state (body: { isActive: boolean })
 */
router.patch('/availability-rules/:ruleId/toggle', VendorAvailabilityController.toggleRule);


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
