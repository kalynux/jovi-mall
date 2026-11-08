import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * One product or service listing a customer saved (Phase 6 · 6.E.1; listings 2026-11-08).
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
/**
 * What a row saves (LISTING-REVIEWS-SAVES-REFERRALS-PLAN § 3.2, owner RS-1: one saved list,
 * products and service listings side by side).
 *
 * ⚠ **Absent means `product`.** Rows written before 2026-11-08 carry no `kind` and are not
 * backfilled, so every reader asks `kindOfWishlistRow()` rather than comparing the field.
 */
export const WISHLIST_ITEM_KINDS = ['product', 'listing'] as const;
export type WishlistItemKind = (typeof WISHLIST_ITEM_KINDS)[number];

export function kindOfWishlistRow(row: { kind?: string | null }): WishlistItemKind {
  return row.kind === 'listing' ? 'listing' : 'product';
}

export interface IWishlistItem extends Document {
  customer_id: mongoose.Types.ObjectId;
  /** Absent on rows written before listings could be saved; read through `kindOfWishlistRow`. */
  kind?: WishlistItemKind;
  /** Set on a product row, absent on a listing row. */
  product_id?: mongoose.Types.ObjectId | null;
  /** Set on a listing row, absent on a product row. */
  listing_id?: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

const WishlistItemSchema = new Schema<IWishlistItem>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    kind: { type: String, enum: WISHLIST_ITEM_KINDS, default: 'product' },
    // Exactly one of the two, by `kind`. Never written as `null`: the two unique indexes below
    // are partial on the field's TYPE, and a null would still be indexed by a non-partial one.
    product_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.PRODUCT,
      required: function (this: IWishlistItem) { return kindOfWishlistRow(this) === 'product'; },
    },
    listing_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.LISTING,
      required: function (this: IWishlistItem) { return kindOfWishlistRow(this) === 'listing'; },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * ⚠ **These two indexes ARE the deduplication.** Not a `findOne` before the insert.
 *
 * Two taps on a "save" button race, and a check-then-write loses that race silently — the
 * list then shows the same item twice and every count is wrong. The repository upserts
 * against these indexes instead, so concurrency is the database's problem rather than the
 * service's, which is the same argument `channel_connections` makes about "one account per
 * messaging identity".
 *
 * **Partial on the id's type** (2026-11-08). The product index used to cover every row, and a
 * listing row has no `product_id`, which a plain unique index reads as `null`: a customer's
 * second saved listing would have collided with their first. Each kind is now unique on its
 * own id, among the rows that have one.
 *
 * `autoIndex` is OFF in production, so both are also built by a migration
 * (`migrate:wishlist-listing-kind`, which swaps the old product index for the partial one).
 * Without it the uniqueness claim above is enforced by nothing, which is indistinguishable
 * from working until two people click quickly.
 */
WishlistItemSchema.index(
  { customer_id: 1, product_id: 1 },
  { unique: true, name: 'wishlist_one_product_per_customer', partialFilterExpression: { product_id: { $type: 'objectId' } } }
);
WishlistItemSchema.index(
  { customer_id: 1, listing_id: 1 },
  { unique: true, name: 'wishlist_one_listing_per_customer', partialFilterExpression: { listing_id: { $type: 'objectId' } } }
);

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
