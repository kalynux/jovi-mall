import { z } from 'zod';

/**
 * Upload Attachment Validator
 * 
 * Validates visibility parameters when uploading attachments.
 * Supports PUBLIC (default) and PRIVATE visibility with explicit user list.
 */

export const UploadAttachmentSchema = z.object({
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
    visibleToUserIds: z.array(z.string()).optional()
        .refine(
            (ids) => !ids || ids.length > 0,
            { message: 'visibleToUserIds must contain at least one user ID if provided' }
        )
});

export type UploadAttachmentInput = z.infer<typeof UploadAttachmentSchema>;
