import { z } from 'zod';

/**
 * Bulk Update Request Validation
 */
export const BulkUpdateItemSchema = z.object({
    variantId: z.string().min(1, 'Variant ID is required'),
    quantity: z.number().int('Quantity must be an integer')
});

export const BulkUpdateRequestSchema = z.object({
    updates: z.array(BulkUpdateItemSchema)
        .min(1, 'Must provide at least one update')
        .max(1000, 'Bulk update limited to 1000 rows')
});

/**
 * Inventory History Query Validation
 */
export const InventoryHistoryQuerySchema = z.object({
    variantId: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50)
});

/**
 * Reservations Query Validation
 */
export const ReservationsQuerySchema = z.object({
    variantId: z.string().optional(),
    status: z.enum(['active', 'expired']).optional().default('active'),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50)
});

/**
 * Alerts Query Validation
 */
export const AlertsQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50)
});
