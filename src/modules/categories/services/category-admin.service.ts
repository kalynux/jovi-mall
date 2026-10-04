import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { ProductModel } from '../../catalog/models/product.model';
import { cleanCategoryName, matchKey, slugifyCategory } from '../domain/category-match';
import {
    productCategoryRepository,
    ProductCategoryRepository,
    ProductCategoryRow,
} from '../repositories/product-category.repository';
import { categoryCatalogCache, CategoryCatalogCache } from './category-catalog.cache';

export interface AdminCategoryDto {
    id: string;
    name: string;
    slug: string;
    aliasKeys: string[];
    createdSource: string;
    createdByVendorId: string | null;
    createdAt: string;
    updatedAt: string;
}

export function toAdminCategoryDto(row: ProductCategoryRow): AdminCategoryDto {
    return {
        id: row._id.toString(),
        name: row.name,
        slug: row.slug,
        aliasKeys: row.alias_keys ?? [],
        createdSource: row.created_source,
        createdByVendorId: row.created_by_vendor_id ? row.created_by_vendor_id.toString() : null,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}

/**
 * Rename, merge, delete — the clean-up tools for the shared list (owner decision C-4).
 *
 * Reached ONLY through `/api/internal/admin/categories` (wi-admin delegates, audits
 * fail-closed, and holds the permission). Reads are wi-admin's own — it queries
 * `product_categories` directly — so nothing here lists.
 *
 * Three rules, each because the obvious version is wrong:
 *
 *  - **A rename keeps the old spelling as an alias.** Renaming "Shose" to "Shoes"
 *    must not make "shose" creatable again next week.
 *  - **A merge REMEMBERS.** The source's key and its own aliases become aliases of
 *    the target, so the matcher sends the next vendor who types the merged name to
 *    the survivor. This is how translations ("Chaussures" → "Shoes"), which no
 *    spelling rule can see, stop coming back.
 *  - **A delete is refused while live products hold the category.** Deleting would
 *    strip a shelf off other vendors' products without asking them, and could leave a
 *    product with no category at all. A merge is the tool for retiring a used one.
 */
export class CategoryAdminService {
    constructor(
        private readonly repo: ProductCategoryRepository = productCategoryRepository,
        private readonly cache: CategoryCatalogCache = categoryCatalogCache,
    ) {}

    async rename(id: string, rawName: string): Promise<{ category: AdminCategoryDto; previousName: string }> {
        const current = await this.mustFindLive(id);
        const name = cleanCategoryName(rawName);
        if (!name) throw createAppError(ERROR_CODES.CATEGORY_NAME_INVALID, 400, undefined, { name: rawName });

        const key = matchKey(name);
        const others = (await this.repo.listLive()).filter((c) => c._id.toString() !== id);
        const clash = others.find((c) => c.match_key === key || (c.alias_keys ?? []).includes(key));
        if (clash) {
            throw createAppError(ERROR_CODES.CATEGORY_NAME_TAKEN, 409, undefined, {
                existingId: clash._id.toString(),
                existingName: clash.name,
            });
        }

        let slug = current.slug;
        const wantedSlug = slugifyCategory(name);
        if (wantedSlug !== current.slug) {
            slug = wantedSlug;
            for (let n = 2; await this.repo.slugTaken(slug, id); n++) slug = `${wantedSlug}-${n}`;
        }

        const renamed = await this.repo.rename(id, { name, slug, match_key: key });
        if (!renamed) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id });

        // The old spelling stays reachable. Not inside the rename write because it is
        // a no-op when only the display case changed (same key).
        let result = renamed;
        if (current.match_key !== key) {
            await transactionManager.runInTransaction(async (session) => {
                result = (await this.repo.addAliasKeys(id, [current.match_key], session)) ?? renamed;
            });
        }
        this.cache.invalidate();
        return { category: toAdminCategoryDto(result), previousName: current.name };
    }

    /**
     * Merge `sourceId` INTO `targetId`, in one transaction: every product holding the
     * source holds the target in its place (order kept, de-duplicated), the source's
     * spellings become the target's aliases, and the source is retired with
     * `merged_into` so an old link can be followed.
     *
     * Products are rewritten whether or not they are soft-deleted — a restored product
     * must not come back pointing at a category that no longer exists.
     */
    async merge(sourceId: string, targetId: string): Promise<{
        source: AdminCategoryDto;
        target: AdminCategoryDto;
        productsUpdated: number;
    }> {
        if (sourceId === targetId) {
            throw createAppError(ERROR_CODES.CATEGORY_MERGE_INVALID, 422, undefined, { reason: 'same_category' });
        }
        const source = await this.mustFindLive(sourceId);
        const target = await this.repo.findLiveById(targetId);
        if (!target) {
            throw createAppError(ERROR_CODES.CATEGORY_MERGE_INVALID, 422, undefined, {
                reason: 'target_not_live',
                targetId,
            });
        }

        const src = new Types.ObjectId(sourceId);
        const tgt = new Types.ObjectId(targetId);

        const outcome = await transactionManager.runInTransactionWithRetry(async (session) => {
            const update = await ProductModel.updateMany(
                { categoryIds: src },
                [
                    {
                        $set: {
                            categoryIds: {
                                $reduce: {
                                    input: {
                                        $map: {
                                            input: '$categoryIds',
                                            as: 'c',
                                            in: { $cond: [{ $eq: ['$$c', src] }, tgt, '$$c'] },
                                        },
                                    },
                                    initialValue: [],
                                    in: {
                                        $cond: [
                                            { $in: ['$$this', '$$value'] },
                                            '$$value',
                                            { $concatArrays: ['$$value', ['$$this']] },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                ],
                { session },
            ).exec();

            const aliasKeys = [source.match_key, ...(source.alias_keys ?? [])].filter((k) => k !== target.match_key);
            const updatedTarget = await this.repo.addAliasKeys(targetId, aliasKeys, session);
            if (!updatedTarget) {
                throw createAppError(ERROR_CODES.CATEGORY_MERGE_INVALID, 422, undefined, {
                    reason: 'target_not_live',
                    targetId,
                });
            }
            const retired = await this.repo.retire(sourceId, targetId, session);
            if (!retired) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id: sourceId });
            return { productsUpdated: update.modifiedCount, target: updatedTarget };
        });

        this.cache.invalidate();
        return {
            source: toAdminCategoryDto({ ...source, merged_into: tgt, deletedAt: new Date() }),
            target: toAdminCategoryDto(outcome.target),
            productsUpdated: outcome.productsUpdated,
        };
    }

    async remove(id: string): Promise<{ category: AdminCategoryDto }> {
        const current = await this.mustFindLive(id);
        const oid = new Types.ObjectId(id);
        const productCount = await ProductModel.countDocuments({ categoryIds: oid, deletedAt: null }).exec();
        if (productCount > 0) {
            throw createAppError(ERROR_CODES.CATEGORY_IN_USE, 409, undefined, { productCount });
        }
        await transactionManager.runInTransaction(async (session) => {
            // Soft-deleted products may still hold it; drop it so a restore does not
            // resurrect an id nothing can render.
            await ProductModel.updateMany(
                { categoryIds: oid, deletedAt: { $ne: null } },
                { $pull: { categoryIds: oid } },
                { session },
            ).exec();
            const retired = await this.repo.retire(id, null, session);
            if (!retired) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id });
        });
        this.cache.invalidate();
        return { category: toAdminCategoryDto({ ...current, deletedAt: new Date() }) };
    }

    private async mustFindLive(id: string): Promise<ProductCategoryRow> {
        const row = await this.repo.findLiveById(id);
        if (!row) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id });
        return row;
    }
}

export const categoryAdminService = new CategoryAdminService();
