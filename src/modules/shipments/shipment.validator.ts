import { z } from 'zod';

/**
 * Shipment API Validators
 */

// Set/update the carrier tracking number on a shipment.
// Mirrors the tracking-number constraint used by the ticket validator.
export const SetTrackingNumberSchema = z.object({
    trackingNumber: z.string().trim().min(1, 'Tracking number is required').max(120, 'Tracking number too long')
});

export type SetTrackingNumberDto = z.infer<typeof SetTrackingNumberSchema>;

// List shipments query parameters (agency self-service list).
// 'pending' is intentionally excluded — a shipment sits there from order
// creation, before any vendor review/dispatch; an agency never sees it.
export const ListShipmentsQuerySchema = z.object({
    status: z.enum(['assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListShipmentsQuery = z.infer<typeof ListShipmentsQuerySchema>;

// Agency-triggered status transition. Only the subset the agency may set
// directly — see AGENCY_TRIGGERABLE_TRANSITIONS in shipment.service.ts.
export const UpdateShipmentStatusSchema = z.object({
    status: z.enum(['picked_up', 'in_transit', 'agent_delivered', 'failed', 'returned'], {
        errorMap: () => ({ message: 'Invalid shipment status' })
    })
});

export type UpdateShipmentStatusDto = z.infer<typeof UpdateShipmentStatusSchema>;

// Reject an assigned shipment. Fixed reason enum (not free text) — mirrors
// ProductSuspensionReason's scoped-reason pattern. The four concrete reasons are
// self-describing; `other` is not, so it REQUIRES a free-text note (≤200 chars)
// explaining the decision. The note is optional for the concrete reasons.
export const RejectShipmentSchema = z
    .object({
        reason: z.enum(['out_of_coverage_area', 'capacity_exceeded', 'invalid_address', 'vendor_item_not_ready', 'other'], {
            errorMap: () => ({ message: 'Invalid rejection reason' })
        }),
        note: z.string().trim().max(200, 'Rejection note must be 200 characters or fewer').optional()
    })
    .superRefine((data, ctx) => {
        // `.trim()` has already run, so an all-whitespace note is now '' (falsy).
        if (data.reason === 'other' && !data.note) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['note'],
                message: 'A note is required when the rejection reason is "other"'
            });
        }
    });

export type RejectShipmentDto = z.infer<typeof RejectShipmentSchema>;

// Assign one of the agency's own agents to a shipment.
export const AssignAgentSchema = z.object({
    agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID')
});

export type AssignAgentDto = z.infer<typeof AssignAgentSchema>;
