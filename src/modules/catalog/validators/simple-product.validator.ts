import { z } from 'zod';
import { productFileIdsSchema, pickupLocationSchema } from './product.validator';
// The same fragment the layered variant endpoints use — one definition, so the
// two editors cannot disagree about what a bargain window is. Both schemas here
// are .strict(), so omitting it would 400 the field rather than ignore it.
import { BargainRangeSchema } from './variant.validator';

/**
 * Simple-mode product schemas.
 *
 * These are deliberately FLAT: one body carries both the product fields and the
 * single variant's price/stock/dimensions, because a vendor selling one pair of
 * shoes should not have to know that "price" lives on a variant. The service
 * layer splits them back apart.
 *
 * Kept in their own file rather than grown onto product.validator.ts — that file
 * describes the layered multi-step flow, and mixing a product+variant union into
 * it would blur the very distinction the simple mode exists to hide.
 */

const tagsSchema = z.array(
    z.string().min(1, 'Each tag must be a non-empty string')
).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'Tags must be unique' }
);

/**
 * POST /api/vendor/products/simple
 *
 * `type` is not accepted — simple mode is physical-only by definition. Nor are
 * `mode`, `status`, `deliveryAgencyId`, `optionValueIds`, `digitalConfig` or
 * `serviceConfig`: each of those belongs to a capability the simple editor does
 * not expose, and silently accepting them would make `mode: 'simple'` a lie.
 */
export const CreateSimpleProductSchema = z.object({
    // ─── Product ──────────────────────────────────────────────────────────────
    title: z.string()
        .min(3, 'Title must be at least 3 characters')
        .max(200, 'Title must not exceed 200 characters')
        .trim(),
    // Required here although the multi-step flow allows an empty description on
    // draft creation: an empty description is an activation blocker, and this
    // endpoint's whole purpose is to come out the other side publishable.
    description: z.string().min(1, 'Description cannot be empty'),
    category: z.string().min(1, 'Category cannot be empty'),
    tags: tagsSchema.optional(),
    fileIds: productFileIdsSchema.optional(),
    seoTitle: z.string().max(60, 'SEO title must not exceed 60 characters').optional(),
    seoDescription: z.string().max(160, 'SEO description must not exceed 160 characters').optional(),

    // ─── The single variant ───────────────────────────────────────────────────
    // Strictly positive, unlike CreateVariantSchema's `.min(0)`. A zero-priced
    // variant can never be activated (CATALOG_PRODUCT_VARIANT_ZERO_PRICE), so
    // accepting 0 here would only buy the vendor a silent blocker later.
    price: z.number().positive('Price must be greater than 0'),
    compareAtPrice: z.number().min(0).optional(),
    // Optional. `minPrice` may be omitted — it defaults to `price` above, which
    // this schema already forces positive.
    bargain: BargainRangeSchema.optional(),
    stock: z.number().int().min(0, 'Stock must be non-negative').default(0),
    isInfiniteStock: z.boolean().default(false),
    // Optional: auto-generated from the title + product id when omitted.
    sku: z.string().min(1).max(100, 'SKU must be at most 100 characters').optional(),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),

    // ─── Delivery ─────────────────────────────────────────────────────────────
    freeDelivery: z.boolean().default(false),
    // Omit to let PickupLocationResolver derive it from the vendor's profile.
    pickupLocation: pickupLocationSchema.optional(),

    // Attempt activation after creating. False saves a draft outright.
    publish: z.boolean().default(true),
}).strict();

/**
 * PATCH /api/vendor/products/:id/simple
 *
 * Every field optional; at least one required. `publish` has NO default here —
 * absent means "leave the status alone", which is what stops a price edit from
 * silently republishing something the vendor deliberately unpublished.
 */
export const UpdateSimpleProductSchema = z.object({
    // ─── Product ──────────────────────────────────────────────────────────────
    title: z.string().min(3).max(200).trim().optional(),
    description: z.string().min(1, 'Description cannot be empty').optional(),
    category: z.string().min(1, 'Category cannot be empty').optional(),
    tags: tagsSchema.optional(),
    fileIds: productFileIdsSchema.optional(),
    seoTitle: z.string().max(60).optional(),
    seoDescription: z.string().max(160).optional(),

    // ─── The single variant ───────────────────────────────────────────────────
    price: z.number().positive('Price must be greater than 0').optional(),
    compareAtPrice: z.number().min(0).optional(),
    // Explicit null clears the range. A bare `price` edit auto-syncs its minPrice.
    bargain: BargainRangeSchema.nullable().optional(),
    stock: z.number().int().min(0).optional(),
    isInfiniteStock: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(1).nullable().optional(),
    allowOversell: z.boolean().optional(),
    sku: z.string().min(1).max(100).optional(),
    weight: z.number().min(0).optional(),
    length: z.number().min(0).optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),

    // ─── Delivery ─────────────────────────────────────────────────────────────
    freeDelivery: z.boolean().optional(),
    // Explicit null clears it (and blocks activation until one is set again).
    pickupLocation: pickupLocationSchema.nullable().optional(),

    publish: z.boolean().optional(),
}).strict().refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided for update' }
);

export type CreateSimpleProductInput = z.infer<typeof CreateSimpleProductSchema>;
export type UpdateSimpleProductInput = z.infer<typeof UpdateSimpleProductSchema>;
