import { z } from 'zod';

/**
 * Vendor Order API Validators
 * 
 * Zod schemas for request validation.
 */

// List orders query parameters
export const ListOrdersQuerySchema = z.object({
    // Filters. 'partially_shipped'/'shipped'/'partially_delivered'/'delivered' are
    // system-derived (see OrderFulfillmentAggregationService) — listed here for
    // filtering only, never settable via UpdateFulfillmentStatusSchema below.
    status: z.enum(['pending', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'delivered', 'fulfilled', 'cancelled']).optional(),
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

// Update fulfillment status. Vendor-triggerable subset only — 'shipped'/
// 'partially_shipped'/'partially_delivered'/'delivered' are system-derived from
// shipment states (OrderFulfillmentAggregationService) and rejected here.
export const UpdateFulfillmentStatusSchema = z.object({
    status: z.enum(['pending', 'processing', 'cancelled'], {
        errorMap: () => ({ message: 'Invalid fulfillment status' })
    })
});

export type UpdateFulfillmentStatusDto = z.infer<typeof UpdateFulfillmentStatusSchema>;

// Bulk-update fulfillment status for many orders at once. Same vendor-triggerable
// status subset as UpdateFulfillmentStatusSchema — each order is validated against
// its own current state independently (see VendorOrderService.bulkUpdateFulfillmentStatus),
// so some orders in the batch may succeed while others fail.
export const BulkUpdateFulfillmentStatusSchema = z.object({
    orderIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid order ID'))
        .min(1, 'At least one order ID is required')
        .max(50, 'Cannot update more than 50 orders at once'),
    status: z.enum(['pending', 'processing', 'cancelled'], {
        errorMap: () => ({ message: 'Invalid fulfillment status' })
    })
});

export type BulkUpdateFulfillmentStatusDto = z.infer<typeof BulkUpdateFulfillmentStatusSchema>;

// Bulk-dispatch many paid physical orders to their delivery agency/agencies.
export const BulkDispatchToAgencySchema = z.object({
    orderIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid order ID'))
        .min(1, 'At least one order ID is required')
        .max(50, 'Cannot dispatch more than 50 orders at once'),
});

export type BulkDispatchToAgencyDto = z.infer<typeof BulkDispatchToAgencySchema>;

// Reassign the delivery agency for a SINGLE order item (physical orders only).
// Scoped to one item so an order can be split across multiple agencies — changing
// one item's agency must never overwrite the others.
export const UpdateDeliveryAgencySchema = z.object({
    itemId: z.string()
        .regex(/^[0-9a-fA-F]{24}$/, 'Invalid order item ID'),
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
