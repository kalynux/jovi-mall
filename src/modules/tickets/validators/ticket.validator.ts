import { z } from 'zod';
import {
    TICKET_TYPE_VALUES,
    TICKET_STATUS_VALUES,
    TICKET_PRIORITY_VALUES,
    TICKET_IMPORTANCE_VALUES,
    ACTOR_ROLE_VALUES,
    ENTITY_TYPE_VALUES,
    EntityType
} from '../types/ticket.types';

/**
 * Ticket API Validators
 *
 * Zod schemas for request validation.
 */

/**
 * One administrator, as wi-admin sends them on the internal admin API.
 *
 * This schema is the CONTRACT for the profile snapshot stored on a ticket — the only thing
 * between wi-admin's payload and a block rendered to a customer, and `tier` in particular
 * decides who may later see the ticket. `.strict()` so an unrecognised key is a 400 rather
 * than a silently stripped field: a caller sending `jobTitle` and getting a 200 back would
 * reasonably believe it had been stored.
 *
 * Declared here, above its first use, because these are `const` bindings — referencing it
 * from `CreateTicketSchema` below while it sat further down the file would be a
 * temporal-dead-zone crash at module load, not a compile error.
 */
const AdminSnapshotSchema = z.object({
    id: z.string().min(1),
    // Only ever `'admin'` on this path. Present because the stored shape carries it, and
    // omitting it here would mean the schema and the model disagreed about the block.
    source: z.literal('admin').default('admin'),
    name: z.string().min(1).max(200),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    job_title: z.string().max(120).nullable().default(null),
    department: z.string().max(120).nullable().default(null),
    avatar_url: z.string().max(2048).nullable().default(null)
}).strict();

// Create ticket
export const CreateTicketSchema = z.object({
    subject: z.string().min(1, 'Subject is required').max(200, 'Subject too long'),
    description: z.string().min(1, 'Description is required').max(700, 'Description too long'),
    type: z.enum(TICKET_TYPE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid ticket type' })
    }),
    importance: z.enum(TICKET_IMPORTANCE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid importance level' })
    }),
    entityType: z.enum(ENTITY_TYPE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid entity type' })
    }),
    // Optional for `OTHER` (general/policy questions have no related entity — the
    // controller defaults it to the requester's own id). Required otherwise.
    entityId: z.string().min(1).optional(),
    // Optional supporting info — required ones are enforced per vendor support policy.
    trackingNumber: z.string().trim().min(1).max(120).optional(),
    attachments: z.array(z.string().trim().min(1)).max(5).optional(),
    /**
     * The administrator opening this ticket on somebody's behalf. Sent only by wi-admin on
     * the internal admin API; absent on every role-facing route, where the creator is a
     * platform user who resolves in this database.
     */
    admin: AdminSnapshotSchema.optional()
}).superRefine((data, ctx) => {
    if (data.entityType !== EntityType.OTHER && !data.entityId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entityId'],
            message: 'Entity ID is required'
        });
    }
});

export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;

// Update ticket
export const UpdateTicketSchema = z.object({
    subject: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(10000).optional()
}).refine(data => data.subject || data.description, {
    message: 'At least one field must be provided'
});

export type UpdateTicketDto = z.infer<typeof UpdateTicketSchema>;

// Update status
export const UpdateStatusSchema = z.object({
    status: z.enum(TICKET_STATUS_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid status' })
    })
});

export type UpdateStatusDto = z.infer<typeof UpdateStatusSchema>;

// Assign ticket
export const AssignTicketSchema = z.object({
    targetRole: z.enum(ACTOR_ROLE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid target role' })
    }),
    targetUserId: z.string().optional()
});

export type AssignTicketDto = z.infer<typeof AssignTicketSchema>;

/**
 * Assign a ticket to an administrator (internal admin API only).
 *
 * `assignedBy` is optional because CLAIMING has no assigner. The controller decides which it
 * is by comparing ids rather than trusting its presence.
 */
export const AssignToAdministratorSchema = z.object({
    admin: AdminSnapshotSchema,
    assignedBy: AdminSnapshotSchema.optional()
}).strict();

export type AssignToAdministratorDto = z.infer<typeof AssignToAdministratorSchema>;

/**
 * Re-stamp the assignee's profile (internal admin API only).
 *
 * Deliberately a DIFFERENT schema and a different route from `AssignToAdministrator`, even
 * though the payload is a subset. Sending `{ admin }` to `/assign` means "this administrator
 * now holds the ticket, claimed" — it would reassign on every edit and clear `assigned_by`.
 * A refresh must be unable to express that, so it cannot share the endpoint.
 */
export const RefreshAdminSnapshotSchema = z.object({
    admin: AdminSnapshotSchema
}).strict();

export type RefreshAdminSnapshotDto = z.infer<typeof RefreshAdminSnapshotSchema>;

// Update priority
export const UpdatePrioritySchema = z.object({
    priority: z.enum(TICKET_PRIORITY_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid priority' })
    })
});

export type UpdatePriorityDto = z.infer<typeof UpdatePrioritySchema>;

// List tickets query parameters
export const ListTicketsQuerySchema = z.object({
    // Filters
    type: z.string().optional(),
    status: z.enum(TICKET_STATUS_VALUES as [string, ...string[]]).optional(),
    priority: z.enum(TICKET_PRIORITY_VALUES as [string, ...string[]]).optional(),
    entityType: z.enum(ENTITY_TYPE_VALUES as [string, ...string[]]).optional(),
    entityId: z.string().optional(),
    createdByUserId: z.string().optional(),
    assignedToRole: z.enum(ACTOR_ROLE_VALUES as [string, ...string[]]).optional(),
    assignedToUserId: z.string().optional(),

    // Pagination
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(['createdAt', 'updatedAt', 'priority', 'status']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
});

export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;
