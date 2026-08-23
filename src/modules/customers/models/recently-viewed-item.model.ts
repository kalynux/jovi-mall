import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * One product a customer looked at (Phase 6 · 6.E.2).
 *
 * ── Why `Customer.recent_product_code` could not hold this ───────────────────
 * That field is a single client-set string and it is still there (decision **O-2** — it is
 * maintained by this feature's write path rather than retired, see
 * `RecentlyViewedService.record`). "Recently viewed" is a *list*: ordered, deduplicated,
 * capped. One string cannot be any of those things, so this is a collection rather than an
 * extension of that field.
 *
 * ── The shape mirrors `WishlistItem`, and the ONE difference is the whole point ──
 * Same `(customer_id, product_id)` unique index, same dangling-reference tolerance, same
 * degrade-on-read rule. What differs is what happens on a repeat:
 *
 *   - **Wishlist**: re-saving keeps the original `created_at`. A wishlist is ordered by
 *     when you *decided*, and tapping save twice is not a new decision.
 *   - **Here**: re-viewing **moves the entry to the head** by overwriting `viewed_at`. A
 *     history is ordered by when you last *looked*, and a product you returned to is more
 *     recent than one you have not opened since.
 *
 * Getting that backwards produces a list that looks right and is stale in exactly the
 * places a customer would notice, so `test:recently-viewed` asserts the direction.
 *
 * ⚠ There is **no TTL and no age-based pruning**. The cap
 * (`CUSTOMER_CATALOG_CONFIG.RECENTLY_VIEWED_CAP`, enforced on write) is therefore the whole
 * retention policy for what amounts to a record of what a person looked at. Say so out loud
 * before raising it.
 */
export interface IRecentlyViewedItem extends Document {
  customer_id: mongoose.Types.ObjectId;
  product_id: mongoose.Types.ObjectId;
  /**
   * When this product was **last** opened. Overwritten on every repeat view — this is the
   * field that moves an entry to the head, and the field the cap evicts from the tail.
   */
  viewed_at: Date;
  created_at: Date;
  updated_at: Date;
}

const RecentlyViewedItemSchema = new Schema<IRecentlyViewedItem>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
    viewed_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * ⚠ **This index IS the deduplication**, exactly as it is on `WishlistItem`.
 *
 * A product page that fires its "record a view" call twice — a double render, a retry, a
 * user tapping back and forward — must produce one row. A check-then-insert loses that race
 * and leaves the same product in the list twice, which then evicts a *different* product
 * when the cap is applied. The repository upserts against this index instead.
 */
RecentlyViewedItemSchema.index({ customer_id: 1, product_id: 1 }, { unique: true });

/**
 * The list read AND the eviction, both served from here.
 *
 * `viewed_at: -1` rather than `created_at: -1` — the list is ordered by when a product was
 * last opened, not when it was first opened. Sorting by the wrong one of those two is
 * invisible until somebody revisits an old product and it fails to move.
 */
RecentlyViewedItemSchema.index({ customer_id: 1, viewed_at: -1 });

export const RecentlyViewedItemModel = mongoose.model<IRecentlyViewedItem>(
  MODELS.RECENTLY_VIEWED_ITEM,
  RecentlyViewedItemSchema,
  COLLECTIONS.RECENTLY_VIEWED_ITEM
);
