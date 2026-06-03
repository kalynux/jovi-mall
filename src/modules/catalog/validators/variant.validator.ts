import { z } from 'zod';

/**
 * Variant Validation Schemas
 * 
 * Zod schemas for variant CRUD operations
 */

// Digital-specific per-variant config. `assetId` is NOT accepted here — it is set
// only by the file-upload endpoints, preventing vendors from claiming arbitrary asset IDs.
const VariantDigitalConfigSchema = z.object({
    maxDownloads: z.number().int().positive().nullable().optional(),
    expiresAfterDays: z.number().int().positive().nullable().optional(),
});

// Variant media. Full-array replacement; duplicates are rejected so the same image
// can't be attached twice. Matches the product validator's fileIds rules.
// Per-type count caps (physical 3 / digital 1) are enforced in the controller,
// where the parent product type is known.
const variantFileIdsSchema = z.array(
    z.string().regex(/^[0-9a-fA-F]{24}$/, 'Each fileId must be a valid MongoDB ObjectId')
).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'File IDs must be unique' }
);

export const CreateVariantSchema = z.object({
    sku: z.string().min(1, 'SKU is required').max(100, 'SKU must be at most 100 characters'),
    name: z.string().min(1, 'Name is required').max(100, 'Name must be at most 100 characters').optional(), // Optional; digital read model falls back to "<asset> - <format> - <size>"
    price: z.number().min(0, 'Price must be positive'),
    compareAtPrice: z.number().min(0).optional(),
    stock: z.number().int().min(0, 'Stock must be non-negative').default(0),
    isInfiniteStock: z.boolean().default(false),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    optionValueIds: z.array(z.string()).optional().default([]),
    deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
    fileIds: variantFileIdsSchema.optional(),
    digitalConfig: VariantDigitalConfigSchema.optional(),
});

export const UpdateVariantSchema = z.object({
    sku: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(100).optional(),
    price: z.number().min(0).optional(),
    compareAtPrice: z.number().min(0).optional(),
    stock: z.number().int().min(0).optional(),
    isInfiniteStock: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(1).nullable().optional(),
    allowOversell: z.boolean().optional(),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    optionValueIds: z.array(z.string()).optional(),
    deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
    fileIds: variantFileIdsSchema.optional(),
    digitalConfig: VariantDigitalConfigSchema.optional(),
});

// Body for PATCH /products/:productId/variants/:variantId/digital/config
export const UpdateVariantDigitalConfigSchema = VariantDigitalConfigSchema.refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one of maxDownloads, expiresAfterDays must be provided' }
);

export const VariantQuerySchema = z.object({
    status: z.enum(['active', 'archived']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Body for PATCH /products/:productId/variants/:variantId/status — vendor-driven
// toggle between active and archived (e.g. temporarily disable a variant during
// a stock shortage). Activation runs through ProductStatusValidationService.
export const ChangeVariantStatusSchema = z.object({
    status: z.enum(['active', 'archived'], {
        required_error: 'Status is required',
    }),
});

export type CreateVariantInput = z.infer<typeof CreateVariantSchema>;
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>;
export type VariantQueryInput = z.infer<typeof VariantQuerySchema>;
export type UpdateVariantDigitalConfigInput = z.infer<typeof UpdateVariantDigitalConfigSchema>;
export type ChangeVariantStatusInput = z.infer<typeof ChangeVariantStatusSchema>;
