import mongoose from 'mongoose';
import { WishlistItemModel, IWishlistItem } from '../models/wishlist-item.model';

/**
 * Persistence for a customer's saved products (Phase 6 · 6.E.1).
 *
 * Every method is scoped by `customer_id` in the QUERY, never by filtering afterwards.
 * That is the convention every owner-scoped repository here follows, and it is what makes
 * "another customer's row is not found rather than forbidden" true by construction — a
 * scoped query cannot return somebody else's row, so there is no place for an ownership
 * check to be forgotten.
 */
export class WishlistRepository {
  /**
   * Save a product. Idempotent.
   *
   * An upsert against the unique `(customer_id, product_id)` index rather than a
   * check-then-insert: two taps on a save button race, and the check-then-write loses that
   * race silently, leaving a duplicate row that makes the list and every count wrong.
   *
   * `$setOnInsert` on the timestamp, so re-saving does **not** move an entry to the head of
   * the list. A wishlist is ordered by when it was saved, and a second tap is not a new
   * save — that is the opposite of the recently-viewed list's rule, and the two are
   * deliberately different.
   */
  async add(customerId: string, productId: string): Promise<IWishlistItem> {
    const now = new Date();
    return (await WishlistItemModel.findOneAndUpdate(
      { customer_id: toId(customerId), product_id: toId(productId) },
      { $setOnInsert: { created_at: now, updated_at: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).exec()) as IWishlistItem;
  }

  /** Remove a save. Returns whether a row was actually there — the caller answers 404 on false. */
  async remove(customerId: string, productId: string): Promise<boolean> {
    const result = await WishlistItemModel.deleteOne({
      customer_id: toId(customerId),
      product_id: toId(productId),
    }).exec();
    return result.deletedCount > 0;
  }

  /** One page of a customer's saves, newest first, served by the `(customer_id, created_at)` index. */
  async listPage(
    customerId: string,
    page: number,
    limit: number
  ): Promise<{ rows: IWishlistItem[]; total: number }> {
    const filter = { customer_id: toId(customerId) };
    const [rows, total] = await Promise.all([
      WishlistItemModel.find(filter)
        .sort({ created_at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      WishlistItemModel.countDocuments(filter).exec(),
    ]);
    return { rows, total };
  }

  /**
   * Which of these products this customer has saved.
   *
   * For a product grid that renders a filled or empty heart per card. Returns a Set of ids
   * rather than rows, because that is the only question being asked and returning documents
   * invites a caller to read fields that happen to be there.
   */
  async savedIdsAmong(customerId: string, productIds: string[]): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();

    const rows = await WishlistItemModel.find(
      { customer_id: toId(customerId), product_id: { $in: productIds.map(toId) } },
      { product_id: 1, _id: 0 }
    ).exec();

    return new Set(rows.map((r) => r.product_id.toString()));
  }
}

/**
 * ⚠ Not `new ObjectId(x)` at each call site.
 *
 * Every id reaching this repository has already been validated as 24-hex by a Zod schema at
 * the route, so this cannot throw in practice — but it is the one place a future caller
 * reaching in from a script would find out, so it stays in one function rather than five.
 */
function toId(value: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
  return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value;
}

export const wishlistRepository = new WishlistRepository();
