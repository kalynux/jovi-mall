import { z } from 'zod';

/**
 * Admin Profile Update Schema
 *
 * Admins have onboarding_step = 0 always (no onboarding flow).
 * This validator covers general self-profile updates.
 */
export const UpdateAdminProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    avatar_url: z.string().url('avatar_url must be a valid URL').nullable().optional(),
    job_title: z.string().min(1).max(100).trim().nullable().optional(),
    department: z.string().min(1).max(100).trim().nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
});

export type UpdateAdminProfileInput = z.infer<typeof UpdateAdminProfileSchema>;
