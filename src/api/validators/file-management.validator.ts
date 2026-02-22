import { z } from 'zod';

/**
 * File Management Validators
 * 
 * Zod schemas for validating file management API requests.
 */

/**
 * List Files Query Parameters
 * GET /api/files
 */
export const ListFilesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    mimeType: z.string().optional(),
    provider: z.enum(['local', 's3', 'gcs', 'r2', 'firebase', 'cloudinary']).optional(),
});

export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;

/**
 * Update File Metadata
 * PATCH /api/files/:id
 */
export const UpdateFileSchema = z.object({
    originalName: z.string().min(1).max(255),
});

export type UpdateFileInput = z.infer<typeof UpdateFileSchema>;

/**
 * List Orphans Query Parameters
 * GET /api/files/orphans
 * 
 * Guardrail: olderThan must be at least 24 hours in the past
 */
export const OrphansQuerySchema = z.object({
    olderThan: z.coerce.date().optional(), // Default: 7 days ago
}).refine(
    (data) => {
        if (!data.olderThan) return true; // Will use default
        const minDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
        return data.olderThan <= minDate;
    },
    { message: 'olderThan must be at least 24 hours in the past' }
);

export type OrphansQuery = z.infer<typeof OrphansQuerySchema>;
