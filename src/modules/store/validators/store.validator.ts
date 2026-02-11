import { z } from 'zod';

/**
 * Update Store Profile Schema
 * 
 * Validates the SHAPE of profile update requests.
 * Business policy (immutability, vendor ownership) is enforced in service layer.
 * 
 * SECURITY: slug and country are NOT accepted (immutable).
 */
export const UpdateStoreProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  // slug NOT accepted (immutable in vendor API)
  logoUrl: z.string().url('Logo URL must be valid').optional(),
  bannerUrl: z.string().url('Banner URL must be valid').optional(),
  description: z.string().max(1000, 'Description too long').optional(),
  address: z.string().max(200, 'Address too long').optional(),
  city: z.string().max(100, 'City name too long').optional(),
  // country NOT accepted (immutable)
  supportEmail: z.string().email('Invalid email format').optional(),
  supportPhone: z.string().min(8).max(20).optional(),
  supportWhatsapp: z.string().min(8).max(20).optional(),
  version: z.number().int().min(0, 'Version must be non-negative'), // REQUIRED
});

/**
 * Update Store Status Schema
 * 
 * Validates vacation mode toggle requests.
 */
export const UpdateStoreStatusSchema = z.object({
  isOpen: z.boolean({
    required_error: 'isOpen is required',
    invalid_type_error: 'isOpen must be a boolean',
  }),
  version: z.number().int().min(0, 'Version must be non-negative'), // REQUIRED
});

/**
 * Type exports for TypeScript
 */
export type UpdateStoreProfileInput = z.infer<typeof UpdateStoreProfileSchema>;
export type UpdateStoreStatusInput = z.infer<typeof UpdateStoreStatusSchema>;
