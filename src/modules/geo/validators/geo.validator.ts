import { z } from 'zod';

/**
 * Query validation for the address-search endpoints. Express query values arrive
 * as strings, so numeric/list params are coerced/parsed here.
 */

export const GeoSearchQuerySchema = z.object({
    /** Free-form address text the user typed. */
    q: z.string().trim().min(1, 'Search query is required').max(300),
    /** Max candidates (1–20). Defaults applied by the provider when omitted. */
    limit: z.coerce.number().int().min(1).max(20).optional(),
    /** Comma-separated ISO-3166-1 alpha-2 codes to bias results (e.g. "cm,ng"). */
    country: z
        .string()
        .trim()
        .optional()
        .transform(v => (v ? v.split(',').map(c => c.trim()).filter(Boolean) : undefined)),
    /** Preferred result language (BCP-47, e.g. "fr"). */
    lang: z.string().trim().max(10).optional(),
});

export type GeoSearchQuery = z.infer<typeof GeoSearchQuerySchema>;

export const GeoReverseQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
});

export type GeoReverseQuery = z.infer<typeof GeoReverseQuerySchema>;
