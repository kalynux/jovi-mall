import { z } from 'zod';

/**
 * Vendor Order API Validators
 * 
 * Zod schemas for request validation.
 */

// List orders query parameters
export const ListOrdersQuerySchema = z.object({
    // Filters
    status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'fulfilled', 'cancelled']).optional(),
    paymentStatus: z.enum(['pending', 'AWAITING_PAYMENT', 'paid', 'failed', 'refunded']).optional(),
    dateFrom: z.string().datetime().optional(),  // ISO 8601
    dateTo: z.string().datetime().optional(),    // ISO 8601
    q: z.string().max(100).optional(),  // Search query

    // Pagination
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(['created_at', 'updated_at', 'total_amount']).default('created_at'),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// Update fulfillment status
export const UpdateFulfillmentStatusSchema = z.object({
    status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled'], {
        errorMap: () => ({ message: 'Invalid fulfillment status' })
    })
});

export type UpdateFulfillmentStatusDto = z.infer<typeof UpdateFulfillmentStatusSchema>;

// Create note
export const CreateNoteSchema = z.object({
    message: z.string()
        .min(1, 'Note message cannot be empty')
        .max(2000, 'Note message cannot exceed 2000 characters')
});

export type CreateNoteDto = z.infer<typeof CreateNoteSchema>;

// Timeline query parameters
export const TimelineQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)  // Hard limit enforced
});

export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
