import { z } from 'zod';
import { ClearablePhoneNumberSchema } from '../../../core/validation/phone';
import { ClearableEmailAddressSchema } from '../../../core/validation/email';
import { clearable } from '../../../core/validation/zod.helpers';
import { GeoAddressZodSchema } from '../../../core/types/geo-address.types';
import { richDocSchema } from '../../../core/richtext';
import { ProductCategoriesSchema } from '../../categories/validators/category.validator';
import {
  LISTING_STATUSES,
  LISTING_SOCIAL_NETWORKS,
  LISTING_ON_EMPTY,
  LISTING_MAX_PHOTOS,
  LISTING_MAX_SOCIALS,
  LISTING_TITLE_MAX,
  LISTING_COMPANY_MAX,
  LISTING_DESCRIPTION_MAX,
} from '../domain/listing.types';
import { isHttpUrl } from '../domain/listing-rules';

/**
 * Request schemas for the listings module (SERVICE-LISTINGS-PLAN § C-3). camelCase on the wire,
 * snake_case in Mongo.
 *
 * ── Saving is partial; completeness is judged at SUBMIT ──────────────────────
 * Every content field is optional on create and PATCH: a provider saves a half-written draft.
 * Whether it is complete is a business rule (`422 LISTING_INCOMPLETE`, `details.missing[]`),
 * judged by `findMissing` when they submit — never a 400 here.
 *
 * ── What IS refused here (400) ───────────────────────────────────────────────
 * Wrong types and malformed values: a phone that is not E.164, an email that is not one, a
 * website or social link that is not http(s), more than 10 photos or 5 categories. The ONE
 * format rule that is NOT a 400 is the video host: a link to the wrong site is a business rule
 * with its own code (`422 LISTING_VIDEO_LINK_INVALID`), judged in the service.
 */

const ObjectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');

const HttpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(isHttpUrl, { message: 'Must be a full http(s) link (e.g. https://example.com)' });

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (24-hour)');

/** The vendor model's weekly-hours shape (L-28), in wire case. */
const OpeningHoursEntrySchema = z.object({
  day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
  openTime: TimeSchema,
  closeTime: TimeSchema,
  isClosed: z.boolean().default(false),
}).strict();

const OpeningHoursSchema = z
  .array(OpeningHoursEntrySchema)
  .max(7)
  .refine((rows) => new Set(rows.map((r) => r.day)).size === rows.length, { message: 'Each day may appear once' });

export const ListingContentInputSchema = z.object({
  title: z.string().trim().max(LISTING_TITLE_MAX).optional(),
  companyName: z.string().trim().max(LISTING_COMPANY_MAX).optional(),
  /** The product category list and its duplicate guard, reused as is (plan § Shared pieces). */
  categories: ProductCategoriesSchema.optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'An ISO-3166-1 alpha-2 code, e.g. CM')
    .transform((v) => v.toUpperCase()).optional(),
  city: z.string().trim().max(80).optional(),
  /** The vendor-typed neighbourhood — public and indexed (stated defaults). */
  area: z.string().trim().max(80).optional(),
  description: z.string().trim().max(LISTING_DESCRIPTION_MAX).optional(),
  descriptionRich: richDocSchema.nullable().optional(),
  /** The provider's OWN uploaded files; ownership is checked when they are attached. */
  photoFileIds: z.array(ObjectIdSchema).max(LISTING_MAX_PHOTOS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A photo may appear once' })
    .optional(),
  openingHours: OpeningHoursSchema.nullable().optional(),
}).strict();

const SocialLinkSchema = z.object({
  network: z.enum(LISTING_SOCIAL_NETWORKS),
  url: HttpUrlSchema,
}).strict();

export const ListingContactsInputSchema = z.object({
  whatsapp: ClearablePhoneNumberSchema,
  phone: ClearablePhoneNumberSchema,
  email: ClearableEmailAddressSchema,
  website: clearable(HttpUrlSchema),
  socials: z.array(SocialLinkSchema).max(LISTING_MAX_SOCIALS).optional(),
  /** Address + pin as one field (L-8): the GeoAddress the address search returned. */
  location: GeoAddressZodSchema.nullable().optional(),
  /** YouTube or Google Drive only — the host is judged in the service (422, not 400). */
  video: z.object({ url: z.string().trim().min(1).max(500) }).strict().nullable().optional(),
}).strict();

/** `POST /api/vendor/listings` and `PATCH /api/vendor/listings/:id` — both halves optional. */
export const ListingWriteSchema = z.object({
  content: ListingContentInputSchema.optional(),
  contacts: ListingContactsInputSchema.optional(),
}).strict();

export type ListingContentInput = z.infer<typeof ListingContentInputSchema>;
export type ListingContactsInput = z.infer<typeof ListingContactsInputSchema>;
export type ListingWriteInput = z.infer<typeof ListingWriteSchema>;

export const ListingIdParamSchema = z.object({ id: ObjectIdSchema });

export const VendorListingListQuerySchema = z.object({
  status: z.enum(LISTING_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

/** `PUT /api/vendor/listing-settings` — the whole object (a PUT). */
export const ListingSettingsSchema = z.object({
  onEmpty: z.enum(LISTING_ON_EMPTY),
  debtFloor: z.number().int().nullable(),
  maxCreditsPerCustomerPerDay: z.number().int().min(0).nullable(),
}).strict();

// ─── Internal admin (§ C-3) ──────────────────────────────────────────────────

export const AdminApproveSchema = z.object({}).strict();

export const AdminRejectSchema = z.object({
  reasons: z.array(z.string().trim().min(3).max(500)).min(1).max(5),
}).strict();

export const AdminSuspendSchema = z.object({
  note: z.string().trim().min(3).max(500),
}).strict();

export const AdminUnsuspendSchema = z.object({
  note: z.string().trim().min(3).max(500).optional(),
}).strict();

// ─── Public (§ C-3) ──────────────────────────────────────────────────────────

/** Upper bound on one `/public/listings/by-ids` request — the bot's search result set. */
export const LISTINGS_BY_IDS_MAX = 50;

export const PublicListingListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  /** A category id, slug or exact name variant — resolved like the product filter. */
  category: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'An ISO-3166-1 alpha-2 code').optional(),
  city: z.string().trim().min(1).max(80).optional(),
  area: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PublicListingListQuery = z.infer<typeof PublicListingListQuerySchema>;

export const PublicListingsByIdsQuerySchema = z.object({
  ids: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const raw = Array.isArray(value) ? value : [value];
      return [...new Set(raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))];
    })
    .pipe(
      z.array(ObjectIdSchema)
        .min(1, 'ids must name at least one listing')
        .max(LISTINGS_BY_IDS_MAX, `ids may name at most ${LISTINGS_BY_IDS_MAX} listings per request`),
    ),
});

export const PublicListingSlugParamSchema = z.object({
  slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A listing slug is lowercase letters, digits and single hyphens'),
});
