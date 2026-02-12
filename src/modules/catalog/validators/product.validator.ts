import { z } from 'zod';

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
    description: z.string().optional(),
    fileIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid file ID')).optional(),

    // SEO
    seoTitle: z.string().max(60, 'SEO title must not exceed 60 characters').optional(),
    seoDescription: z.string().max(160, 'SEO description must not exceed 160 characters').optional(),

    // Digital config
    digitalConfig: z.object({
        assetId: z.string().optional(),
        maxDownloads: z.number().int().positive().nullable().optional(),
        expiresAfterDays: z.number().int().positive().nullable().optional(),
        isActive: z.boolean().optional(),
    }).optional(),

    // Service config
    serviceConfig: z.object({
        durationMinutes: z.number().int().min(1, 'Duration must be at least 1 minute'),
        bufferBeforeMinutes: z.number().int().min(0).optional(),
        bufferAfterMinutes: z.number().int().min(0).optional(),
        bookingMode: z.enum(['calendar', 'manual', 'capacity']),
    }).optional(),
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
    description: z.string().optional(),
    fileIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid file ID')).optional(),

    // SEO
    seoTitle: z.string().max(60, 'SEO title must not exceed 60 characters').optional(),
    seoDescription: z.string().max(160, 'SEO description must not exceed 160 characters').optional(),

    // Digital config
    digitalConfig: z.object({
        assetId: z.string().optional(),
        maxDownloads: z.number().int().positive().nullable().optional(),
        expiresAfterDays: z.number().int().positive().nullable().optional(),
        isActive: z.boolean().optional(),
    }).optional(),

    // Service config
    serviceConfig: z.object({
        durationMinutes: z.number().int().min(1).optional(),
        bufferBeforeMinutes: z.number().int().min(0).optional(),
        bufferAfterMinutes: z.number().int().min(0).optional(),
        bookingMode: z.enum(['calendar', 'manual', 'capacity']).optional(),
    }).optional(),
}).refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided for update' }
);

/**
 * Schema for changing product status
 */
export const ChangeProductStatusSchema = z.object({
    status: z.enum(['draft', 'active', 'archived', 'pending_review', 'suspended'], {
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
