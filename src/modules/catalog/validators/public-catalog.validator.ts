import { z } from 'zod';

/**
 * Request schemas for the public storefront.
 *
 * Every one of these parses input from an **unauthenticated** caller, so they are the outer
 * edge of the service: nothing downstream re-checks a bound, and a value that gets through
 * here reaches an aggregation pipeline. Two consequences shape the file:
 *
 *   - **Every bound is explicit.** An unbounded `limit` on a world-readable endpoint is a
 *     denial-of-service primitive — one request asking for a million rows.
 *   - **Every string that reaches Mongo is length-capped.** `q` in particular becomes a
 *     `$text` search; the cap is what stops a megabyte of search terms.
 *
 * Zod errors surface as `400 VALIDATION_ERROR` with `details.fields[]` through the global
 * handler, which is exactly the contract §2.1 asks for.
 */

/** Shared page/limit. `limit` is capped at 100 by the platform-wide pagination contract. */
const PageSchema = z.coerce.number().int().min(1).default(1);
const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * `type` accepts a repeated param (`?type=a&type=b`) or a comma-separated list.
 *
 * Express gives a repeated query param as `string[]` and a single one as `string`, so both
 * shapes have to be handled anyway; accepting commas as well costs one `split` and saves
 * every client from having to know which convention this API picked.
 */
const ProductTypeSchema = z.enum(['physical', 'digital', 'service']);

const ProductTypesSchema = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
        if (value === undefined) return undefined;
        const raw = Array.isArray(value) ? value : [value];
        const flat = raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
        return flat.length > 0 ? flat : undefined;
    })
    .pipe(z.array(ProductTypeSchema).nonempty().optional());

/**
 * Money is a whole number in the account currency.
 *
 * `XAF` has no minor unit, so there are no cents to allow — a fractional bound here would
 * silently never match. Negative prices are refused rather than clamped: a client sending
 * one has a bug, and quietly rewriting it to 0 hides it.
 */
const MoneySchema = z.coerce.number().int().min(0);

/** A store slug, matching `Store.slug`'s own schema regex. */
export const StoreSlugSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'A store slug is lowercase letters, digits and single hyphens');

/**
 * A product slug.
 *
 * Deliberately wider than the store slug — the same reasoning the blog applies to article
 * slugs. Vendors name products in five languages, and forcing ASCII would push French and
 * Arabic catalogues onto transliterated paths that are worse for the shopper and worse for
 * search. Lowercase letters in any script, digits and single hyphens still refuse spaces,
 * slashes, capitals and punctuation — everything that makes a slug unsafe in a path.
 */
export const ProductSlugSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
        /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u,
        'A product slug is lowercase letters, digits and single hyphens — no spaces, slashes or capitals',
    );

/** A 24-hex ObjectId. Rejected here so a malformed id never reaches a `$match`. */
export const ObjectIdSchema = z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');

export const PublicProductListQuerySchema = z
    .object({
        q: z.string().trim().min(1).max(200).optional(),
        category: z.string().trim().min(1).max(200).optional(),
        type: ProductTypesSchema,
        storeSlug: StoreSlugSchema.optional(),
        minPrice: MoneySchema.optional(),
        maxPrice: MoneySchema.optional(),
        // Only the literal `true` narrows. `?inStock=false` is treated as "don't filter"
        // rather than "show me only what is out of stock", which nothing asks for.
        inStock: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => (v === 'true' ? true : undefined)),
        /**
         * No `popularity`, deliberately. Nothing tracks sales — `Product.lastOrderedAt`
         * exists and is read by nobody — so the option would either be a lie or a silent
         * alias for another sort. See BACKEND-SHOP-REQUIREMENTS §4.
         */
        sort: z.enum(['newest', 'price_asc', 'price_desc', 'relevance']).default('newest'),
        page: PageSchema,
        limit: LimitSchema,
    })
    .refine(
        (v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice,
        { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
    );

export type PublicProductListQuery = z.infer<typeof PublicProductListQuerySchema>;

/** The store's own product list — §2.1's params minus `storeSlug`, which is the path. */
export const PublicStoreProductListQuerySchema = PublicProductListQuerySchema.innerType()
    .omit({ storeSlug: true })
    .refine(
        (v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice,
        { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
    );

export const PublicStoreListQuerySchema = z.object({
    q: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(200).optional(),
    page: PageSchema,
    limit: LimitSchema,
});

export type PublicStoreListQuery = z.infer<typeof PublicStoreListQuerySchema>;

export const PublicProductIdParamSchema = z.object({ productId: ObjectIdSchema });

export const PublicStoreSlugParamSchema = z.object({ storeSlug: StoreSlugSchema });

export const PublicProductSlugsParamSchema = z.object({
    storeSlug: StoreSlugSchema,
    productSlug: ProductSlugSchema,
});

/** `GET /api/public/stores/:slug` and `…/:slug/products` both key on this. */
export const PublicSlugParamSchema = z.object({ slug: StoreSlugSchema });
