import { z } from 'zod';

/**
 * Attach Attachment Validator
 *
 * Validates the body when attaching a file to a ticket. The file must already
 * have been uploaded via POST /api/files/upload; only its returned `fileId` is
 * sent here (same pattern as product images). Supports PUBLIC (default) and
 * PRIVATE visibility with an explicit user list.
 */

export const AttachFileSchema = z.object({
    fileId: z.string().min(1, 'fileId is required'),
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
    visibleToUserIds: z.array(z.string()).optional()
        .refine(
            (ids) => !ids || ids.length > 0,
            { message: 'visibleToUserIds must contain at least one user ID if provided' }
        )
});

export type AttachFileInput = z.infer<typeof AttachFileSchema>;
