import mongoose from 'mongoose';
import { RecentlyViewedItemModel, IRecentlyViewedItem } from '../models/recently-viewed-item.model';

/**
 * Persistence for a customer's recently-viewed products (Phase 6 · 6.E.2).
 *
 * Scoped by `customer_id` in every query, like `WishlistRepository` — see its header for
 * why that is what makes "somebody else's row is not found" true by construction.
 */
export class RecentlyViewedRepository {
  /**
   * Record a view: insert, or move an existing entry to the head.
   *
   * ⚠ **`$set: { viewed_at }` and NOT `$setOnInsert`** — this is the one line where this
   * collection differs from the wishlist, and getting it wrong produces a list that looks
   * correct and never reorders. A product opened again today must sort above one opened
   * last week, so the timestamp is overwritten on every call.
   *
   * Returns whether a row was **created**, and the caller uses that to decide whether the
   * cap needs enforcing. Re-viewing cannot grow the list, so the common case — a customer
   * browsing back through products they have already seen — costs exactly one write and no
   * eviction query at all.
   */
  async touch(customerId: string, productId: string, viewedAt: Date): Promise<{ inserted: boolean }> {
    const result = await RecentlyViewedItemModel.updateOne(
      { customer_id: toId(customerId), product_id: toId(productId) },
      { $set: { viewed_at: viewedAt }, $setOnInsert: { created_at: viewedAt } },
      { upsert: true }
    ).exec();

    return { inserted: result.upsertedCount > 0 };
  }

  /**
   * Drop everything past the cap, oldest first. Returns how many went.
   *
   * Two statements rather than one, because Mongo cannot express "delete all but the newest
   * N" in a single `deleteMany`: the ids are selected by a sorted, skipped read and then
   * removed by id. The read is served entirely by the `(customer_id, viewed_at)` index and
   * projects `_id` alone.
   *
   * ⚠ **Not `deleteMany` by an age cutoff.** A time window and a count cap are different
   * policies, and this one is a count: a customer who looks at forty products in an hour
   * must end up with `cap` rows, not forty.
   *
   * Benign under concurrency. Two calls racing can both select the same overflow row and one
   * deletes nothing — the outcome is still "at most `cap` rows", which is the invariant. It
   * can also transiently leave the list one row short of the cap if a view lands between
   * the select and the delete; that self-heals on the next view and is the direction to err
   * in.
   */
  async evictBeyondCap(customerId: string, cap: number): Promise<number> {
    const overflow = await RecentlyViewedItemModel.find(
      { customer_id: toId(customerId) },
      { _id: 1 }
    )
      .sort({ viewed_at: -1, _id: -1 })
      .skip(cap)
      .exec();

    if (overflow.length === 0) return 0;

    const result = await RecentlyViewedItemModel.deleteMany({
      _id: { $in: overflow.map((row) => row._id) },
    }).exec();

    return result.deletedCount ?? 0;
  }

  /** One page, most recently viewed first. */
  async listPage(
    customerId: string,
    page: number,
    limit: number
  ): Promise<{ rows: IRecentlyViewedItem[]; total: number }> {
    const filter = { customer_id: toId(customerId) };
    const [rows, total] = await Promise.all([
      RecentlyViewedItemModel.find(filter)
        .sort({ viewed_at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      RecentlyViewedItemModel.countDocuments(filter).exec(),
    ]);
    return { rows, total };
  }

  /** Forget everything this customer looked at. */
  async clear(customerId: string): Promise<number> {
    const result = await RecentlyViewedItemModel.deleteMany({
      customer_id: toId(customerId),
    }).exec();
    return result.deletedCount ?? 0;
  }
}

function toId(value: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
  return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value;
}

export const recentlyViewedRepository = new RecentlyViewedRepository();
