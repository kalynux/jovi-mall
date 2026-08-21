import { z } from 'zod';

/**
 * File Management Validators
 * 
 * Zod schemas for validating file management API requests.
 */

/**
 * Broad media categories mapped onto MIME types so callers can filter by the
 * kind of media without knowing exact MIME strings. The concrete MIME matching
 * for each category lives in the controller (`MEDIA_CATEGORY_MATCHERS`).
 */
export const MEDIA_CATEGORIES = ['image', 'video', 'audio', 'document', 'archive', 'other'] as const;

/**
 * List Files Query Parameters
 * GET /api/files
 *
 * Supports pagination, full-text-style search on the file name, and filtering
 * by file characteristics (MIME type / category, provider, owner, size range,
 * upload date range) plus sorting.
 */
export const ListFilesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),

    // Search: case-insensitive substring match on originalName.
    search: z.string().trim().min(1).max(255).optional(),

    // Characteristic filters.
    mimeType: z.string().optional(),
    category: z.enum(MEDIA_CATEGORIES).optional(),
    provider: z.enum(['local', 's3', 'gcs', 'r2', 'firebase', 'cloudinary']).optional(),
    ownerType: z.enum(['vendor', 'admin', 'customer', 'agent', 'agency', 'system']).optional(),
    minSize: z.coerce.number().int().min(0).optional(),
    maxSize: z.coerce.number().int().min(0).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),

    // Sorting.
    sortBy: z.enum(['createdAt', 'updatedAt', 'size', 'originalName']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
})
    .refine(
        (data) => data.minSize === undefined || data.maxSize === undefined || data.minSize <= data.maxSize,
        { message: 'minSize must be less than or equal to maxSize', path: ['minSize'] },
    )
    .refine(
        (data) =>
            !data.createdAfter || !data.createdBefore || data.createdAfter <= data.createdBefore,
        { message: 'createdAfter must be on or before createdBefore', path: ['createdAfter'] },
    );

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
 * GET /api/internal/admin/files/orphans
 *
 * Guardrail: olderThan must be at least 24 hours in the past — a file uploaded a minute
 * ago and attached a minute later is not an orphan, and this is what keeps it out of a
 * delete candidate list.
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
