import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';
import { GeoPointZodSchema } from '../../../core/types/geo.types';
import { GeoAddressZodSchema } from '../../../core/types/geo-address.types';

// ─── Headquarters address (agency's physical / pickup locations) ──────────────
// Same geocoded shape as a vendor business address: the client picks a result
// from `/api/geo/search` and sends it as `geo`. `location`, `region` and `city`
// are all DERIVED from `geo` on write (see `toPersistableHeadquarters`) — the map
// result is the source of truth for where the place is, so the client never has
// to type them. `label` is the one piece of a location the map cannot supply, so
// it is the only required text field alongside `address_description`. Geo presence
// + country match are enforced in the service layer (against the agency's
// registered country).

const SupportContactSchema = z.object({
  phone: z.string().min(6).max(20).trim().regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format'),
  email: clearable(z.string().email('Invalid email format')),
});

export const MagazinHeadquartersAddressSchema = z.object({
  // The agency's own name for this location ("Main depot", "Bonabéri branch").
  // Required on every entry written through this schema; pre-existing rows have
  // none and read back as null.
  label: z.string().min(1, 'Label is required').max(50).trim(),
  // Fallbacks — not overrides — for what `geo.components` omits. Send them only
  // to name a place whose geocode has no city/region; whenever `geo` carries one,
  // `geo` wins.
  region: clearable(z.string().max(100).trim()),
  city: clearable(z.string().max(100).trim()),
  address_description: z.string().min(1).max(200).trim(),
  support_contact: SupportContactSchema,
  // Legacy bare coordinate — optional; derived from `geo` on write.
  location: GeoPointZodSchema.nullable().optional(),
  // The selected address-search result — the canonical geospatial address.
  geo: GeoAddressZodSchema.nullable().optional(),
});

export type MagazinHeadquartersAddressInput = z.infer<typeof MagazinHeadquartersAddressSchema>;

/**
 * Update Magazin Profile Schema
 *
 * Validates the SHAPE of agency-business-surface update requests. Business policy
 * (agency ownership, optimistic locking, coverage-in-country, HQ geo-in-country)
 * is enforced in the service layer.
 *
 * Optional fields are clearable: sending null or '' clears the field, omitting it
 * leaves it unchanged. `name` is required in the model and cannot be cleared.
 */
export const UpdateMagazinProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).optional(),
  logoFileId: clearable(z.string().regex(/^[0-9a-fA-F]{24}$/, 'logoFileId must be a valid file id')),
  description: clearable(z.string().max(1000, 'Description too long')),
  supportEmail: clearable(z.string().email('Invalid email format')),
  supportPhone: clearable(z.string().min(8).max(20)),
  supportWhatsapp: clearable(z.string().min(8).max(20)),
  // Regions the agency serves — validated against the registered country in the service.
  coverage_areas: z.array(z.string().min(1).trim()).min(1, 'At least one coverage area (region) is required').optional(),
  // Physical / pickup locations. Full replace; index 0 = primary. Geo enforced in the service.
  headquarters_addresses: z.array(MagazinHeadquartersAddressSchema).min(1, 'At least one headquarters address is required. The first entry is the primary.').optional(),
  version: z.number().int().min(0, 'Version must be non-negative'), // REQUIRED
});

export type UpdateMagazinProfileInput = z.infer<typeof UpdateMagazinProfileSchema>;
