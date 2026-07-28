import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';

/**
 * Admin Profile Update Schema
 *
 * Admins have onboarding_step = 0 always (no onboarding flow).
 * This validator covers general self-profile updates.
 * Clearable fields accept null or '' to clear (normalised to null).
 */
export const UpdateAdminProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    // Canonical avatar: id of a file uploaded via POST /api/files/upload ('' / null clears it).
    avatar_file_id: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'avatar_file_id must be a valid file id')),
    /** @deprecated Prefer avatar_file_id. Accepted for backward compatibility. */
    avatar_url: clearable(z.string().url('avatar_url must be a valid URL')),
    job_title: clearable(z.string().min(1).max(100).trim()),
    department: clearable(z.string().min(1).max(100).trim()),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
});

export type UpdateAdminProfileInput = z.infer<typeof UpdateAdminProfileSchema>;
