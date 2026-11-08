import { z } from 'zod';

/**
 * Request schemas for a customer's own lists of products — wishlist and recently viewed
 * (Phase 6 · 6.E.1 / 6.E.2).
 *
 * These sit behind `requireAuth` + `requireRole(['customer'])`, unlike
 * `public-catalog.validator.ts`, so the caller is known. The bounds are here for the same
 * reason all the same: a signed-in caller can still ask for a million rows, and every
 * product id reaching a repository becomes a Mongo `ObjectId` — a value that is not 24 hex
 * characters must be a `400` here rather than a cast that throws deeper in.
 */

/** Shared page/limit, matching the platform-wide pagination contract (max 100). */
const PageSchema = z.coerce.number().int().min(1).default(1);
const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * A product id, 24 hex.
 *
 * Constrained here rather than left to Mongoose so a malformed id is a `400 VALIDATION_ERROR`
 * naming the field, not a `500` from a failed `ObjectId` cast — and, on the delete path, not
 * a `404` that would read as "you never saved that" when the truth is "that is not an id".
 */
export const ProductIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'A product id is 24 hexadecimal characters');

export const CustomerCatalogListQuerySchema = z
  .object({ page: PageSchema, limit: LimitSchema })
  .strip();

export const ProductIdParamSchema = z.object({ productId: ProductIdSchema });

/** A service listing id, 24 hex — for the same reasons as `ProductIdSchema`. */
export const ListingIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'A listing id is 24 hexadecimal characters');

export const ListingIdParamSchema = z.object({ listingId: ListingIdSchema });

/** `GET /api/customer/wishlist` — both kinds by default, or one (2026-11-08). */
export const WishlistListQuerySchema = z
  .object({ page: PageSchema, limit: LimitSchema, kind: z.enum(['product', 'listing']).optional() })
  .strip();

/**
 * `POST /api/customer/wishlist` — save a product OR a service listing (2026-11-08): exactly one
 * of the two ids. Both or neither is a 400 naming the rule, never a guess at which was meant.
 */
export const AddWishlistItemSchema = z
  .object({ productId: ProductIdSchema.optional(), listingId: ListingIdSchema.optional() })
  .strict()
  .refine((v) => (v.productId === undefined) !== (v.listingId === undefined), {
    message: 'Send exactly one of productId and listingId',
    path: ['productId'],
  });

/**
 * `POST /api/customer/wishlist/saved-among` — which of these are saved?
 *
 * A POST rather than a GET with a repeated query parameter, and the reason is the bound: a
 * grid page can carry 100 ids, and 100 ids in a query string is ~2.5 KB of URL, which is
 * within spec and outside what several proxies and access logs handle gracefully. It reads
 * nothing and writes nothing; the verb is transport, not semantics.
 */
export const SavedAmongSchema = z
  .object({
    productIds: z.array(ProductIdSchema).min(1).max(100).optional(),
    // 2026-11-08: a listing grid asks the same question about its own cards.
    listingIds: z.array(ListingIdSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => v.productIds !== undefined || v.listingIds !== undefined, {
    message: 'Send productIds, listingIds, or both',
    path: ['productIds'],
  });

/**
 * `POST /api/customer/recently-viewed` — record a view.
 *
 * ⚠ Deliberately carries **no timestamp**. A client-supplied "viewed at" is a client-chosen
 * position in the list, and the list is capped — so a caller could pin an entry at the head
 * forever, or evict every real entry by claiming a future time. The server clock is the
 * only honest source, and it is the one the cap and the ordering both read.
 */
export const RecordProductViewSchema = z.object({ productId: ProductIdSchema }).strict();

export type CustomerCatalogListQuery = z.infer<typeof CustomerCatalogListQuerySchema>;
export type AddWishlistItemInput = z.infer<typeof AddWishlistItemSchema>;
export type WishlistListQuery = z.infer<typeof WishlistListQuerySchema>;
export type SavedAmongInput = z.infer<typeof SavedAmongSchema>;
export type RecordProductViewInput = z.infer<typeof RecordProductViewSchema>;
