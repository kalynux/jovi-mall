import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { searchCategories } from '../domain/category-match';
import { categoryCatalogCache } from '../services/category-catalog.cache';
import { categoryResolutionService } from '../services/category-resolution.service';
import { categoryAdminService } from '../services/category-admin.service';
import {
    AdminMergeCategorySchema,
    AdminRenameCategorySchema,
    CategoryIdParamSchema,
    CheckCategoryNamesSchema,
    VendorCategoryQuerySchema,
} from '../validators/category.validator';

/**
 * The vendor half — what a product editor needs to pick categories without
 * creating duplicates. Contract: api-doc/vendor/categories.md.
 */
export class VendorCategoryController {
    /**
     * GET /api/vendor/categories?q=&limit=
     *
     * Without `q`: the whole live list, alphabetical (a dropdown). With `q`: the
     * autocomplete — exact spellings first, then prefix, substring, and finally typo
     * suggestions, each flagged with how it matched so the editor can label
     * "Did you mean …?" rows differently from plain hits.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = VendorCategoryQuerySchema.parse(req.query);
        const catalog = await categoryCatalogCache.list();
        if (query.q && query.q.length > 0) {
            const hits = searchCategories(query.q, catalog, query.limit);
            sendSuccess(res, {
                categories: hits.map((h) => ({
                    id: h.category.id,
                    name: h.category.name,
                    slug: h.category.slug,
                    match: h.match,
                })),
            });
            return;
        }
        const sorted = [...catalog].sort((a, b) => a.name.localeCompare(b.name)).slice(0, query.limit);
        sendSuccess(res, {
            categories: sorted.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
            total: catalog.length,
        });
    });

    /**
     * POST /api/vendor/categories/check — body `{ names: string[] }`.
     *
     * The "before saving" probe: what would happen to each typed name. Writes nothing.
     * Optional — the product write gives the same answers — but it lets the editor
     * ask its "Did you mean …?" question as the vendor types rather than on save.
     */
    static check = asyncHandler(async (req: Request, res: Response) => {
        const input = CheckCategoryNamesSchema.parse(req.body);
        const results = await categoryResolutionService.check(input.names);
        sendSuccess(res, { results });
    });
}

/**
 * The administrator half, for wi-admin only (`/api/internal/admin/categories`).
 * There is no list here: wi-admin reads `product_categories` directly.
 */
export class AdminCategoryController {
    /** PATCH /:id — body `{ name }`. 409 CATEGORY_NAME_TAKEN means "merge instead". */
    static rename = asyncHandler(async (req: Request, res: Response) => {
        const { id } = CategoryIdParamSchema.parse(req.params);
        const input = AdminRenameCategorySchema.parse(req.body);
        const result = await categoryAdminService.rename(id, input.name);
        sendSuccess(res, result, { message: 'Category renamed' });
    });

    /** POST /:id/merge — body `{ targetId }`. Moves every product, then retires `:id`. */
    static merge = asyncHandler(async (req: Request, res: Response) => {
        const { id } = CategoryIdParamSchema.parse(req.params);
        const input = AdminMergeCategorySchema.parse(req.body);
        const result = await categoryAdminService.merge(id, input.targetId);
        sendSuccess(res, result, { message: 'Category merged' });
    });

    /** DELETE /:id — refused with 409 CATEGORY_IN_USE while live products hold it. */
    static remove = asyncHandler(async (req: Request, res: Response) => {
        const { id } = CategoryIdParamSchema.parse(req.params);
        const result = await categoryAdminService.remove(id);
        sendSuccess(res, result, { message: 'Category deleted' });
    });
}
