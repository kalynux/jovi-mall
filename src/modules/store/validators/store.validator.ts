import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';
import { ClearableEmailAddressSchema } from '../../../core/validation/email';
import { ClearablePhoneNumberSchema } from '../../../core/validation/phone';

/**
 * Update Store Profile Schema
 *
 * Validates the SHAPE of profile update requests.
 * Business policy (immutability, vendor ownership) is enforced in service layer.
 *
 * SECURITY: slug is NOT accepted (immutable).
 * NO address/city/country: physical locations are the vendor profile's
 * `business_addresses` (geocoded, country-anchored); country lives on the
 * vendor profile (set-once at onboarding) and is served read-only here.
 *
 * Optional fields are clearable: sending null or '' clears the field,
 * omitting it leaves it unchanged. `name` is required in the model and
 * cannot be cleared.
 */
export const UpdateStoreProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  // slug NOT accepted (immutable in vendor API)
  // Logo/banner are the ids of files previously uploaded via POST /api/files/upload
  // (not URLs). Sending '' or null clears the slot. The response returns a derived URL.
  logoFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'logoFileId must be a valid file id')),
  bannerFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'bannerFileId must be a valid file id')),
  description: clearable(z.string().max(1000, 'Description too long')),
  supportEmail: ClearableEmailAddressSchema,
  // WhatsApp is addressed by phone number, so it is held to the same E.164 rule
  // as any other number — the provider will not accept anything else.
  supportPhone: ClearablePhoneNumberSchema,
  supportWhatsapp: ClearablePhoneNumberSchema,
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
