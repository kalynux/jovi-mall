import { z } from 'zod';
import { NOTE_VISIBILITY_VALUES } from '../types/ticket.types';

/**
 * Ticket Note API Validators
 */

// Create note
export const CreateNoteSchema = z.object({
    content: z.string()
        .min(1, 'Note content cannot be empty')
        .max(5000, 'Note content cannot exceed 5000 characters'),
    visibility: z.enum(NOTE_VISIBILITY_VALUES as [string, ...string[]], {
        errorMap: () => ({ message: 'Invalid visibility setting' })
    }).default('public'),
    visibleToUserIds: z.array(z.string()).optional().default([])
});

export type CreateNoteDto = z.infer<typeof CreateNoteSchema>;
