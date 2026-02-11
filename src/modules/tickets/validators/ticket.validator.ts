import { z } from 'zod';
import {
    TICKET_TYPE_VALUES,
    TICKET_STATUS_VALUES,
    TICKET_PRIORITY_VALUES,
    TICKET_IMPORTANCE_VALUES,
    ACTOR_ROLE_VALUES,
    ENTITY_TYPE_VALUES
} from '../types/ticket.types';

/**
 * Ticket API Validators
 * 
 * Zod schemas for request validation.
 */

// Create ticket
export const CreateTicketSchema = z.object({
    subject: z.string().min(1, 'Subject is required').max(200, 'Subject too long'),
    description: z.string().min(1, 'Description is required').max(10000, 'Description too long'),
    type: z.enum(TICKET_TYPE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid ticket type' })
    }),
    importance: z.enum(TICKET_IMPORTANCE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid importance level' })
    }),
    entityType: z.enum(ENTITY_TYPE_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid entity type' })
    }),
    entityId: z.string().min(1, 'Entity ID is required')
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
