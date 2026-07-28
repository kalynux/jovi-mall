import { z } from 'zod';

/**
 * Password strength policy — the single source of truth for every role.
 *
 * The password lives on the User model, not on any role entity, so the policy
 * is account-level. Role-specific validators re-export from here rather than
 * redefining it.
 */
export const PasswordStrengthSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Update Password Schema
 *
 * Validates password change requests (all roles).
 */
export const UpdatePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: PasswordStrengthSchema,
});

export type UpdatePasswordInput = z.infer<typeof UpdatePasswordSchema>;
