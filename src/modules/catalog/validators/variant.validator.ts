import { z } from 'zod';

/**
 * Variant Validation Schemas
 * 
 * Zod schemas for variant CRUD operations
 */

export const CreateVariantSchema = z.object({
    sku: z.string().min(1, 'SKU is required').max(100, 'SKU must be at most 100 characters'),
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
});

export const UpdateVariantSchema = z.object({
    sku: z.string().min(1).max(100).optional(),
    price: z.number().min(0).optional(),
    compareAtPrice: z.number().min(0).optional(),
    stock: z.number().int().min(0).optional(),
    isInfiniteStock: z.boolean().optional(),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    optionValueIds: z.array(z.string()).optional(),
    deliveryAgencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId').optional(),
});

export const VariantQuerySchema = z.object({
    status: z.enum(['active', 'archived']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateVariantInput = z.infer<typeof CreateVariantSchema>;
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>;
export type VariantQueryInput = z.infer<typeof VariantQuerySchema>;
