import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/** Who brought a category into existence. Audit only — it confers no ownership. */
export const CATEGORY_CREATED_SOURCES = ['vendor', 'admin', 'migration'] as const;
export type CategoryCreatedSource = (typeof CATEGORY_CREATED_SOURCES)[number];

export interface IProductCategory extends IBaseDocument {
  /** The display name, as its first author wrote it (or as an admin renamed it). */
  name: string;
  /** URL key — `?category=<slug>` on the storefront. Unique among live rows. */
  slug: string;
  /**
   * `matchKey(name)` from `domain/category-match.ts` — the DUPLICATE GUARD.
   *
   * The partial unique index on it is what makes "Shoes" and "shoes" one category
   * even when two vendors type them in the same millisecond: the matcher's in-memory
   * check is a pre-check, and a pre-check is a race. The resolution service catches
   * the E11000 and re-reads, so the loser of that race reuses the winner's row.
   */
  match_key: string;
  /**
   * Keys of categories an administrator merged INTO this one. The matcher treats
   * them as this category's own spellings, so a merge is remembered: after
   * "Chaussures" is merged into "Shoes", typing "chaussure" lands on "Shoes".
   */
  alias_keys: string[];
  created_source: CategoryCreatedSource;
  /** Set when a vendor created it while editing a product. Never an authorisation input. */
  created_by_vendor_id: Types.ObjectId | null;
  /**
   * Set on a row that was merged away, which is soft-deleted in the same
   * transaction. Kept so an old `?category=<id>` link and an old bot button can be
   * followed to the survivor rather than dead-ending.
   */
  merged_into: Types.ObjectId | null;
}

/**
 * One entry in THE marketplace-wide category list (owner decision C-1).
 *
 * A product references 1–5 of these by id (`Product.categoryIds`). Names are not
 * copied onto products: a rename or a merge is then one write here (plus, for a
 * merge, one `updateMany` on products) instead of a rewrite of every product's text.
 * Readers resolve ids to names through `CategoryCatalogCache`.
 *
 * Design record: PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md.
 */
const ProductCategorySchema = new Schema<IProductCategory>({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  slug: { type: String, required: true },
  match_key: { type: String, required: true },
  alias_keys: { type: [String], default: [] },
  created_source: { type: String, enum: [...CATEGORY_CREATED_SOURCES], required: true },
  created_by_vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, default: null },
  merged_into: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_CATEGORY, default: null },
  ...BaseSchemaFields,
}, BaseSchemaOptions);

// The duplicate guard. PARTIAL on live rows so a merged-away (soft-deleted) category
// does not reserve its key forever — its key lives on as an alias of the survivor,
// which is where the matcher looks for it.
ProductCategorySchema.index(
  { match_key: 1 },
  { unique: true, name: 'product_category_match_key_unique', partialFilterExpression: { deletedAt: null } },
);
ProductCategorySchema.index(
  { slug: 1 },
  { unique: true, name: 'product_category_slug_unique', partialFilterExpression: { deletedAt: null } },
);

export const ProductCategoryModel = model<IProductCategory>(
  MODELS.PRODUCT_CATEGORY,
  ProductCategorySchema,
  COLLECTIONS.PRODUCT_CATEGORY,
);
