import { z } from 'zod';
import {
    SHIPMENT_FAILURE_REASONS,
    SHIPMENT_REJECTION_REASONS,
    ShipmentFailureReason,
    ShipmentRejectionReason,
} from './shipment.model';

/**
 * Shipment API Validators
 */

// There is no tracking-number schema: the shipment's tracking number is
// generated at creation (TrackingNumberGenerator) and read-only, so nothing
// accepts one on the wire. The ticket validator's `trackingNumber` is a
// different thing — a CARRIER's number the reporter types into a support
// ticket — and stays free text.

// List shipments query parameters — SHARED by the agency and agent lists.
// 'pending' is intentionally excluded — a shipment sits there from order
// creation, before any vendor review/dispatch; an agency never sees it.
export const ListShipmentsQuerySchema = z.object({
    status: z.enum(['assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment']).optional(),
    /**
     * Free-text search across the customer's name and phone, the product titles
     * on the shipment, the order number, and the shipment's tracking number.
     *
     * Minimum 2 characters: the search fans out to Customer/Product/Order id
     * sets before filtering shipments (the Shipment document carries no
     * denormalised text), so a 1-character term would resolve most of the
     * platform for nothing. See ShipmentRepository.buildSearchClause.
     */
    q: z.string().trim().min(2, 'Search term must be at least 2 characters').max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListShipmentsQuery = z.infer<typeof ListShipmentsQuerySchema>;

/**
 * The agent's own list query. Adds `scope` — the coarse "still mine to finish"
 * / "over and done with" divide the mobile app's work queue is split on.
 *
 * It cannot be expressed with `status`, which takes exactly one value: "still
 * mine" is five statuses (ACTIVE_SHIPMENT_STATUSES), and the list is paginated,
 * so a client narrowing page 1 locally would under-report every shipment past
 * it. Hence a server-side scope rather than a repeated `status` param.
 *
 * Agent-only, deliberately: `ListShipmentsQuerySchema` is shared with the
 * agency list, and an agency's board has no use for one agent's plate. Adding it
 * to the shared schema would have the agency endpoint silently accept a
 * parameter it ignores.
 *
 * `scope` and `status` compose: `status` is the more specific of the two and
 * wins outright (see ShipmentRepository.findByAgentPaginated).
 */
export const AgentListShipmentsQuerySchema = ListShipmentsQuerySchema.extend({
    scope: z.enum(['active', 'past']).optional(),
});

export type AgentListShipmentsQuery = z.infer<typeof AgentListShipmentsQuerySchema>;

/** The coarse work-queue divide. See AgentListShipmentsQuerySchema. */
export type AgentShipmentScope = AgentListShipmentsQuery['scope'];

// Agency-triggered status transition. Only the subset that may be set directly
// — see TRIGGERABLE_TRANSITIONS in shipment.service.ts.
export const UpdateShipmentStatusSchema = z.object({
    status: z.enum(['picked_up', 'in_transit', 'agent_delivered', 'failed', 'returned'], {
        errorMap: () => ({ message: 'Invalid shipment status' })
    })
});

export type UpdateShipmentStatusDto = z.infer<typeof UpdateShipmentStatusSchema>;

// Agent-triggered status transition on the agent's own shipment. Same target
// statuses and same TRIGGERABLE_TRANSITIONS map as the agency — the only
// difference from UpdateShipmentStatusSchema above is the optional non-delivery
// reason, which the agency endpoint deliberately does not accept.
//
// The reason enum is imported from the model rather than inlined (the pattern
// assignment.validator.ts uses for AGENT_CANCELLATION_REASONS) so the wire
// contract and the Mongoose enum cannot drift.
export const AgentUpdateShipmentStatusSchema = z
    .object({
        status: z.enum(['picked_up', 'in_transit', 'agent_delivered', 'failed', 'returned'], {
            errorMap: () => ({ message: 'Invalid shipment status' })
        }),
        // Optional even on failed/returned — an agent may report the outcome
        // without choosing a reason.
        reason: z
            .enum(SHIPMENT_FAILURE_REASONS as [ShipmentFailureReason, ...ShipmentFailureReason[]], {
                errorMap: () => ({ message: 'Invalid delivery failure reason' })
            })
            .optional(),
        note: z.string().trim().max(200, 'Note must be 200 characters or fewer').optional()
    })
    .superRefine((data, ctx) => {
        const isOutcome = data.status === 'failed' || data.status === 'returned';
        // Rejected rather than silently dropped: a reason on `picked_up` means
        // the caller misunderstood the endpoint, and persisting it would create
        // a record nothing reads.
        if (!isOutcome && data.reason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reason'],
                message: 'A reason may only be given when the status is "failed" or "returned"'
            });
        }
        if (!isOutcome && data.note) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['note'],
                message: 'A note may only be given when the status is "failed" or "returned"'
            });
        }
        // `.trim()` has already run, so an all-whitespace note is now '' (falsy).
        // Mirrors RejectShipmentSchema / CancelShipmentSchema: 'other' is not
        // self-describing, so it must be explained.
        if (data.reason === 'other' && !data.note) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['note'],
                message: 'A note is required when the reason is "other"'
            });
        }
    });

export type AgentUpdateShipmentStatusDto = z.infer<typeof AgentUpdateShipmentStatusSchema>;

// Reject an assigned shipment. Fixed reason enum (not free text) — mirrors
// ProductSuspensionReason's scoped-reason pattern. The four concrete reasons are
// self-describing; `other` is not, so it REQUIRES a free-text note (≤200 chars)
// explaining the decision. The note is optional for the concrete reasons.
export const RejectShipmentSchema = z
    .object({
        // Spread from the model's vocabulary rather than retyped, so the enum here and the
        // schema enum cannot drift. `platform_intervention` is accepted by the shared
        // schema but is the ADMINISTRATOR's reason — an agency naming it is harmless
        // (the row still records `changed_by_role: 'agency'`), and refusing it here would
        // mean a second, narrower copy of the list, which is the drift this spread avoids.
        reason: z.enum(SHIPMENT_REJECTION_REASONS as [ShipmentRejectionReason, ...ShipmentRejectionReason[]], {
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

// The shipment id in a path parameter. Validated rather than passed straight to
// a `findById` so a malformed id is a 400 with a message instead of a Mongoose
// CastError surfacing as a 500 — which matters most on the internal route, where
// the caller is geo-tracker and treats any status >= 300 identically.
export const ShipmentIdParamSchema = z.object({
    shipmentId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid shipment ID'),
});
