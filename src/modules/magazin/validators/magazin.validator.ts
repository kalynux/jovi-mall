import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';

/**
 * Update Magazin Profile Schema
 *
 * Validates the SHAPE of agency-business-surface update requests. Business policy
 * (agency ownership, optimistic locking) is enforced in the service layer.
 *
 * Optional fields are clearable: sending null or '' clears the field, omitting it
 * leaves it unchanged. `name` is required in the model and cannot be cleared.
 */
export const UpdateMagazinProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  // Logo is the id of a file previously uploaded via POST /api/files/upload
  // (not a URL). Sending '' or null clears the slot. The response returns a derived URL.
  logoFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'logoFileId must be a valid file id')),
  description: clearable(z.string().max(1000, 'Description too long')),
  supportEmail: clearable(z.string().email('Invalid email format')),
  supportPhone: clearable(z.string().min(8).max(20)),
  supportWhatsapp: clearable(z.string().min(8).max(20)),
  version: z.number().int().min(0, 'Version must be non-negative'), // REQUIRED
});

export type UpdateMagazinProfileInput = z.infer<typeof UpdateMagazinProfileSchema>;
