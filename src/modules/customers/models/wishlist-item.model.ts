import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * One product a customer saved (Phase 6 · 6.E.1).
 *
 * ── Why a collection and not an array on `Customer` ──────────────────────────
 * A wishlist is unbounded — there is no product-count at which saving another is wrong —
 * and an unbounded array on a document that is loaded on every profile read, every
 * checkout and every notification is a document that grows without a ceiling on the hot
 * path. It also cannot carry a unique constraint: Mongo has no way to say "no two elements
 * of this array share a value", so deduplication would have to be application code, which
 * is exactly what the compound index below replaces.
 *
 * ── One row, three fields, and nothing else ──────────────────────────────────
 * No note, no priority, no "notify me when it drops". Each of those is a real feature and
 * none of them is 6.E.1; adding a nullable column for a feature nobody has specified is how
 * a schema accumulates fields whose meaning nobody can reconstruct later.
 *
 * ⚠ **`product_id` is a reference that is allowed to dangle**, and readers must treat it
 * that way. A vendor can archive, unpublish or soft-delete a product a thousand customers
 * have saved; nothing cascades, deliberately, because a product coming back off suspension
 * should find its wishlists intact. `WishlistService` hydrates through the public catalog's
 * own predicate and degrades a row it cannot resolve — see `listSaved`.
 */
export interface IWishlistItem extends Document {
  customer_id: mongoose.Types.ObjectId;
  product_id: mongoose.Types.ObjectId;
  created_at: Date;
  updated_at: Date;
}

const WishlistItemSchema = new Schema<IWishlistItem>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * ⚠ **This index IS the deduplication.** Not a `findOne` before the insert.
 *
 * Two taps on a "save" button race, and a check-then-write loses that race silently — the
 * list then shows the same product twice and every count is wrong. The repository upserts
 * against this index instead, so concurrency is the database's problem rather than the
 * service's, which is the same argument `channel_connections` makes about "one account per
 * messaging identity".
 *
 * `autoIndex` is OFF in production, so this is also registered as a migration
 * (`migrate:customer-catalog-indexes`). Without it the uniqueness claim above is enforced
 * by nothing, which is indistinguishable from working until two people click quickly.
 */
WishlistItemSchema.index({ customer_id: 1, product_id: 1 }, { unique: true });

/**
 * The list read: one customer's saves, newest first.
 *
 * `created_at: -1` closes the index so the default ordering is served from it rather than
 * sorted in memory — the same reasoning as the admin user directory's compound index.
 */
WishlistItemSchema.index({ customer_id: 1, created_at: -1 });

export const WishlistItemModel = mongoose.model<IWishlistItem>(
  MODELS.WISHLIST_ITEM,
  WishlistItemSchema,
  COLLECTIONS.WISHLIST_ITEM
);
