import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');

/**
 * Query for `GET /api/agency/products`.
 *
 * `.strict()` like `/agency/inventory`: an unknown parameter is a 400, not silently ignored,
 * so a misspelt filter cannot read as "this agency delivers everything".
 */
export const AgencyProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  source: z.enum(['own_override', 'vendor_default']).optional(),
  status: z.enum(['draft', 'active', 'archived', 'pending_review', 'suspended']).optional(),
  categoryId: objectId.optional(),
  vendorId: objectId.optional(),
  sortBy: z.enum(['createdAt', 'title']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
}).strict();

export type AgencyProductsQueryInput = z.infer<typeof AgencyProductsQuerySchema>;
