import { z } from 'zod';
import { VendorConfig } from '../config/vendor.config';

/**
 * Password Strength Validator
 * 
 * Enforces enterprise-grade password requirements:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */
export const PasswordStrengthSchema = z
  .string()
  .min(VendorConfig.PASSWORD.MIN_LENGTH, `Password must be at least ${VendorConfig.PASSWORD.MIN_LENGTH} characters`)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Update Profile Schema
 * 
 * Validates the SHAPE of profile update requests.
 * Business policy (email lock, feature flags) is enforced in the service layer.
 */
export const UpdateProfileSchema = z.object({
  displayName: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(8).max(20).optional(),
  notificationPreferences: z
    .object({
      email: z.boolean().optional(),
      whatsapp: z.boolean().optional(),
      phone: z.boolean().optional(),
    })
    .optional(),
  version: z.number().int().min(0), // Required for optimistic locking
});

/**
 * Update Password Schema
 * 
 * Validates password change requests.
 */
export const UpdatePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: PasswordStrengthSchema,
});

/**
 * Type exports for TypeScript
 */
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export type UpdatePasswordInput = z.infer<typeof UpdatePasswordSchema>;
