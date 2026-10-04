import { ClientSession, Types } from 'mongoose';
import { ProductCategoryModel, IProductCategory, CategoryCreatedSource } from '../models/product-category.model';

/** The lean shape every reader works with. */
export interface ProductCategoryRow {
    _id: Types.ObjectId;
    name: string;
    slug: string;
    match_key: string;
    alias_keys: string[];
    created_source: CategoryCreatedSource;
    created_by_vendor_id: Types.ObjectId | null;
    merged_into: Types.ObjectId | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const ROW_PROJECTION = {
    name: 1,
    slug: 1,
    match_key: 1,
    alias_keys: 1,
    created_source: 1,
    created_by_vendor_id: 1,
    merged_into: 1,
    deletedAt: 1,
    createdAt: 1,
    updatedAt: 1,
} as const;

/**
 * The only writer of `product_categories`.
 *
 * Every write that changes what the matcher sees (create, rename, merge, delete) must
 * be followed by `categoryCatalogCache.invalidate()` — the services do that, not this
 * class, because a write inside a transaction must not invalidate before it commits.
 */
export class ProductCategoryRepository {
    async listLive(): Promise<ProductCategoryRow[]> {
        return ProductCategoryModel.find({ deletedAt: null }, ROW_PROJECTION)
            .lean<ProductCategoryRow[]>()
            .exec();
    }

    async findLiveById(id: string, session?: ClientSession): Promise<ProductCategoryRow | null> {
        if (!Types.ObjectId.isValid(id)) return null;
        return ProductCategoryModel.findOne({ _id: id, deletedAt: null }, ROW_PROJECTION)
            .session(session ?? null)
            .lean<ProductCategoryRow>()
            .exec();
    }

    /** Including soft-deleted rows — used to follow a merged-away id to its survivor. */
    async findAnyById(id: string): Promise<ProductCategoryRow | null> {
        if (!Types.ObjectId.isValid(id)) return null;
        return ProductCategoryModel.findOne({ _id: id }, ROW_PROJECTION).lean<ProductCategoryRow>().exec();
    }

    async findLiveByIds(ids: string[]): Promise<ProductCategoryRow[]> {
        const valid = ids.filter((id) => Types.ObjectId.isValid(id));
        if (valid.length === 0) return [];
        return ProductCategoryModel.find({ _id: { $in: valid }, deletedAt: null }, ROW_PROJECTION)
            .lean<ProductCategoryRow[]>()
            .exec();
    }

    async findLiveByMatchKey(key: string, session?: ClientSession): Promise<ProductCategoryRow | null> {
        return ProductCategoryModel.findOne({ match_key: key, deletedAt: null }, ROW_PROJECTION)
            .session(session ?? null)
            .lean<ProductCategoryRow>()
            .exec();
    }

    async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
        const filter: Record<string, unknown> = { slug, deletedAt: null };
        if (exceptId) filter._id = { $ne: new Types.ObjectId(exceptId) };
        return (await ProductCategoryModel.exists(filter)) !== null;
    }

    async create(
        input: {
            name: string;
            slug: string;
            match_key: string;
            created_source: CategoryCreatedSource;
            created_by_vendor_id: string | null;
        },
        session?: ClientSession,
    ): Promise<ProductCategoryRow> {
        // Array form: Mongoose reads `{ session }` only when the first argument is an
        // array — `create(doc, { session })` silently writes OUTSIDE the transaction.
        const [doc] = await ProductCategoryModel.create(
            [
                {
                    name: input.name,
                    slug: input.slug,
                    match_key: input.match_key,
                    alias_keys: [],
                    created_source: input.created_source,
                    created_by_vendor_id: input.created_by_vendor_id
                        ? new Types.ObjectId(input.created_by_vendor_id)
                        : null,
                    merged_into: null,
                },
            ],
            { session },
        );
        return (doc as IProductCategory).toObject() as unknown as ProductCategoryRow;
    }

    /** Compare-and-set on liveness: a category merged away mid-rename is not renamed. */
    async rename(
        id: string,
        update: { name: string; slug: string; match_key: string },
    ): Promise<ProductCategoryRow | null> {
        return ProductCategoryModel.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: update },
            { new: true, projection: ROW_PROJECTION },
        )
            .lean<ProductCategoryRow>()
            .exec();
    }

    /** Append keys the matcher should treat as the target's own spellings. */
    async addAliasKeys(targetId: string, keys: string[], session: ClientSession): Promise<ProductCategoryRow | null> {
        return ProductCategoryModel.findOneAndUpdate(
            { _id: targetId, deletedAt: null },
            { $addToSet: { alias_keys: { $each: keys } } },
            { new: true, projection: ROW_PROJECTION, session },
        )
            .lean<ProductCategoryRow>()
            .exec();
    }

    /** Soft-delete, recording the survivor when this is a merge. CAS on liveness. */
    async retire(id: string, mergedInto: string | null, session?: ClientSession): Promise<boolean> {
        const res = await ProductCategoryModel.updateOne(
            { _id: id, deletedAt: null },
            {
                $set: {
                    deletedAt: new Date(),
                    merged_into: mergedInto ? new Types.ObjectId(mergedInto) : null,
                },
            },
            { session },
        ).exec();
        return res.modifiedCount === 1;
    }
}

export const productCategoryRepository = new ProductCategoryRepository();
