import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';

// Product media. Full-array replacement; duplicates are rejected so the same image
// can't be attached twice. Shared by create and update; kept in sync with the
// variant validator. Per-type count caps (physical/service 7, digital 1) are
// enforced in the service layer, where the product type is known.
const productFileIdsSchema = z.array(
    z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid file ID')
).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'File IDs must be unique' }
);

// Where the delivery agency should collect this product from — one of the
// vendor's own business addresses, or the agency's own storage. `vendorAddressId`
// is required when `source` is 'vendor_address' (ignored/omitted otherwise).
const pickupLocationSchema = z.object({
    source: z.enum(['vendor_address', 'agency_storage']),
    vendorAddressId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId')),
}).strict().refine(
    (p) => p.source !== 'vendor_address' || !!p.vendorAddressId,
    { message: 'vendorAddressId is required when source is vendor_address' }
);

/**
 * Schema for creating a product
 */
export const CreateProductSchema = z.object({
    type: z.enum(['physical', 'digital', 'service'], {
        required_error: 'Product type is required',
    }),
    title: z.string()
        .min(3, 'Title must be at least 3 characters')
        .max(200, 'Title must not exceed 200 characters')
        .trim(),
    description: z.string().min(1, 'Description cannot be empty'),
    fileIds: productFileIdsSchema.optional(),

    // Categorization
    category: z.string().min(1, 'Category cannot be empty'),
    tags: z.array(
        z.string().min(1, 'Each tag must be a non-empty string')
    ).refine(
        (arr) => new Set(arr).size === arr.length,
        { message: 'Tags must be unique' }
    ).optional(),

    // SEO
    seoTitle: z.string().max(60, 'SEO title must not exceed 60 characters').optional(),
    seoDescription: z.string().max(160, 'SEO description must not exceed 160 characters').optional(),

    // Digital config (product-wide kill switch only; per-variant asset/limits live on the variant)
    digitalConfig: z.object({
        isActive: z.boolean().optional(),
    }).strict().optional(),

    // Service config + price live on the service variant (see variant.validator).
});

/**
 * Schema for updating a product
 * Images field replaces the entire array
 */
export const UpdateProductSchema = z.object({
    title: z.string()
        .min(3, 'Title must be at least 3 characters')
        .max(200, 'Title must not exceed 200 characters')
        .trim()
        .optional(),
    description: z.string().min(1, 'Description cannot be empty').optional(),
    fileIds: productFileIdsSchema.optional(),

    // Categorization
    category: z.string().min(1, 'Category cannot be empty').optional(),
    tags: z.array(
        z.string().min(1, 'Each tag must be a non-empty string')
    ).refine(
        (arr) => new Set(arr).size === arr.length,
        { message: 'Tags must be unique' }
    ).optional(),

    // SEO
    seoTitle: z.string().max(60, 'SEO title must not exceed 60 characters').optional(),
    seoDescription: z.string().max(160, 'SEO description must not exceed 160 characters').optional(),

    // Digital config (product-wide kill switch only)
    digitalConfig: z.object({
        isActive: z.boolean().optional(),
    }).strict().optional(),

    // Service config + price live on the service variant (see variant.validator).

    // Physical delivery config — agencyId may be null to clear the per-product agency.
    // Either sub-field may be sent independently (partial update, merged against
    // the existing value in ProductUpdateService); at least one must be present.
    delivery: z.object({
        agencyId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId')),
        freeDelivery: z.boolean().optional(),
        pickupLocation: pickupLocationSchema.nullable().optional(),
    }).strict().refine(
        (d) => d.agencyId !== undefined || d.freeDelivery !== undefined || d.pickupLocation !== undefined,
        { message: 'At least one of agencyId, freeDelivery, or pickupLocation must be provided' }
    ).optional(),

    // Vectorisation opt-in toggle — when provided, the update endpoint will
    // route through VectorisationService.setEnabled after the content update.
    vectorisationEnabled: z.boolean().optional(),
}).refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided for update' }
);

/**
 * Schema for the consolidated vectorisation toggle endpoint
 * PATCH /api/vendor/products/:id/vectorisation
 */
export const SetVectorisationSchema = z.object({
    enabled: z.boolean({ required_error: 'enabled is required' }),
});

/**
 * Schema for changing product status
 */
export const ChangeProductStatusSchema = z.object({
    status: z.enum(['draft', 'active', 'archived', 'pending_review', 'suspended'], {
        required_error: 'Status is required',
    }),
});

/**
 * Schema for changing product status
 */
export const VendorChangeProductStatusSchema = z.object({
    status: z.enum(['draft', 'active', 'archived'], {
        required_error: 'Status is required',
    }),
});

/**
 * Schema for product query/filtering
 */
export const ProductQuerySchema = z.object({
    type: z.enum(['physical', 'digital', 'service']).optional(),
    status: z.enum(['draft', 'active', 'archived', 'pending_review', 'suspended']).optional(),
    q: z.string().optional(), // Search query

    // Sorting
    sortBy: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),

    // Pagination
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Schema for bulk archive
 */
export const BulkArchiveSchema = z.object({
    productIds: z.array(z.string().min(1, 'Product ID cannot be empty'))
        .min(1, 'At least one product ID is required')
        .max(50, 'Cannot archive more than 50 products at once'),
});

/**
 * Schema for bulk status change
 */
export const BulkStatusChangeSchema = z.object({
    productIds: z.array(z.string().min(1, 'Product ID cannot be empty'))
        .min(1, 'At least one product ID is required')
        .max(50, 'Cannot update more than 50 products at once'),
    status: z.enum(['draft', 'active', 'archived', 'pending_review', 'suspended'], {
        required_error: 'Status is required',
    }),
});

/**
 * Schema for bulk status change
 */
export const VendorBulkStatusChangeSchema = z.object({
    productIds: z.array(z.string().min(1, 'Product ID cannot be empty'))
        .min(1, 'At least one product ID is required')
        .max(50, 'Cannot update more than 50 products at once'),
    status: z.enum(['draft', 'active', 'archived'], {
        required_error: 'Status is required',
    }),
});
