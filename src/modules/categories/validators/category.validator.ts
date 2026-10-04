import { z } from 'zod';
import { MAX_CATEGORIES_PER_PRODUCT } from '../domain/category-match';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid category id');

/**
 * One entry of a product write's `categories` — the SHARED fragment.
 *
 * Wired onto all four product write schemas (layered create/update, simple
 * create/update). Two of those are `.strict()`, so a write path that forgot the
 * field would 400 the whole save rather than ignore it — the same reason the rich
 * description fragment is shared.
 *
 *  - `{ id }`   — a category the client got from the autocomplete.
 *  - `{ name }` — what the vendor typed. Resolved server-side: an exact variant of an
 *                 existing category is reused silently; a look-alike is refused with
 *                 `422 CATEGORY_SIMILAR_EXISTS` unless `confirmNew: true`.
 *
 * Length and content of `name` are judged by `cleanCategoryName` in the service, not
 * here, so a bad name answers the category-specific code rather than a generic 400.
 */
export const CategoryRefSchema = z.union([
    z.object({ id: objectId }).strict(),
    z.object({
        name: z.string().max(200, 'Category name is too long'),
        confirmNew: z.boolean().optional(),
    }).strict(),
]);

export const ProductCategoriesSchema = z
    .array(CategoryRefSchema)
    .min(1, 'A product needs at least one category')
    .max(MAX_CATEGORIES_PER_PRODUCT, `A product can have at most ${MAX_CATEGORIES_PER_PRODUCT} categories`);

/**
 * ⚠ DEPRECATED — the single free-text category every client sent before
 * 2026-10-04. Still accepted when `categories` is absent and treated as one
 * `{ name }`, so a dashboard that has not moved yet keeps saving products across the
 * deploy. Sending both is refused (the two would disagree about which wins).
 */
export const LegacyCategorySchema = z.string().min(1, 'Category cannot be empty').max(200);

export type ProductCategoryRefInput = z.infer<typeof CategoryRefSchema>;

/** `GET /api/vendor/categories` */
export const VendorCategoryQuerySchema = z.object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/** `POST /api/vendor/categories/check` */
export const CheckCategoryNamesSchema = z.object({
    names: z.array(z.string().max(200)).min(1).max(MAX_CATEGORIES_PER_PRODUCT),
}).strict();

export const CategoryIdParamSchema = z.object({ id: objectId });

/** `PATCH /api/internal/admin/categories/:id` */
export const AdminRenameCategorySchema = z.object({
    name: z.string().max(200),
}).strict();

/** `POST /api/internal/admin/categories/:id/merge` */
export const AdminMergeCategorySchema = z.object({
    targetId: objectId,
}).strict();
