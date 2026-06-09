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
    orderType: z.enum(['physical', 'digital']).optional(),  // NEW: Filter by order type
    customerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid customer ID').optional(),  // NEW: Scope to one customer
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

// Update delivery agency (physical orders only)
export const UpdateDeliveryAgencySchema = z.object({
    deliveryAgencyId: z.string()
        .regex(/^[0-9a-fA-F]{24}$/, 'Invalid delivery agency ID')
});

export type UpdateDeliveryAgencyDto = z.infer<typeof UpdateDeliveryAgencySchema>;

// Revoke digital entitlement (digital orders only)
export const RevokeEntitlementSchema = z.object({
    reason: z.string()
        .min(10, 'Reason must be at least 10 characters')
        .max(500, 'Reason cannot exceed 500 characters')
});

export type RevokeEntitlementDto = z.infer<typeof RevokeEntitlementSchema>;

// Restore digital entitlement (digital orders only)
export const RestoreEntitlementSchema = z.object({
    reason: z.string()
        .min(10, 'Reason must be at least 10 characters')
        .max(500, 'Reason cannot exceed 500 characters')
});

export type RestoreEntitlementDto = z.infer<typeof RestoreEntitlementSchema>;

// Create note
export const CreateNoteSchema = z.object({
    message: z.string()
        .min(1, 'Note message cannot be empty')
        .max(2000, 'Note message cannot exceed 2000 characters')
});

export type CreateNoteDto = z.infer<typeof CreateNoteSchema>;

// Refund an order (Customer Management → order detail)
export const RefundRequestSchema = z.object({
    // Optional: defaults to the policy-computed maximum when omitted.
    amount: z.number().positive('Amount must be greater than zero').optional(),
    reason: z.string().max(500, 'Reason cannot exceed 500 characters').optional()
});

export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

// Timeline query parameters
export const TimelineQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)  // Hard limit enforced
});

export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
