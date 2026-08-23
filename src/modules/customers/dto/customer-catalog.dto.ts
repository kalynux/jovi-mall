import { PublicProductListItemDto } from '../../catalog/dto/public-product.dto';
import { publicCatalogService, PublicCatalogService } from '../../catalog/services/public-catalog.service';

/**
 * The shape of one entry in a customer's own list of products — saved, or recently viewed
 * (Phase 6 · 6.E.1 and 6.E.2).
 *
 * ── `product` is nullable, and that is the feature ───────────────────────────
 *
 * A wishlist row can outlive the product it points at. A vendor archives a listing, an
 * agency suspends one over unpaid storage, an administrator takes one down, a vendor is
 * suspended and their whole catalogue goes with them. Nothing cascades into these
 * collections, deliberately — a product coming back off suspension should find its
 * wishlists intact.
 *
 * So the reader has to decide what an unresolvable row means, and there are only three
 * options: fail the request, drop the row, or degrade it. **Degrade** is the only one that
 * is honest:
 *
 *   - *Failing* means one archived product breaks a customer's entire saved list.
 *   - *Dropping* silently shrinks the list, so a customer who saved twelve things sees ten
 *     and no explanation, and the pagination totals stop matching what is rendered.
 *
 * A degraded entry keeps its `productId` and its timestamp and carries `product: null`, so
 * the client can render "this item is no longer available" beside a working remove button.
 * A row whose product is *deleted* and one whose product is merely *suspended* are
 * deliberately indistinguishable here: telling them apart would leak a vendor's catalogue
 * state to anyone who once saved a product, which is the same oracle
 * `public-catalog.service.ts` refuses to be when it answers 404 rather than 403.
 *
 * ── One shape, one resolver, for both lists ──────────────────────────────────
 * Wishlist and recently-viewed differ only in what they sort by and what the timestamp
 * means. Building the card twice would be two places for the storefront's product shape to
 * drift, and the stock-semantics trap in `api-doc/public/catalog.md` (`inStock` is a
 * boolean and never a count) is exactly the kind of thing that drifts.
 */
export interface CustomerCatalogEntryDto {
  /** Always present, even when the product no longer resolves. The remove verb needs it. */
  productId: string;
  /**
   * When this entry was created (wishlist: saved at) or last touched (recently viewed:
   * viewed at). The two lists give it different meanings and each documents its own.
   */
  at: Date;
  /**
   * The storefront card, or `null` when the product is no longer on sale.
   * Identical in shape to a `/api/public/products` row — the same builder produces both.
   */
  product: PublicProductListItemDto | null;
}

/**
 * Turn `(productId, timestamp)` pairs into entries, preserving the caller's order.
 *
 * ⚠ **The caller's order is authoritative and this function never re-sorts.** A wishlist is
 * newest-saved-first and a recently-viewed list is newest-viewed-first; the hydration query
 * returns rows in whatever order Mongo produces them, and re-deriving an order from the
 * hydrated cards would be a third opinion that is wrong for at least one caller.
 */
export async function hydrateCustomerCatalogEntries(
  pairs: Array<{ productId: string; at: Date }>,
  catalog: PublicCatalogService = publicCatalogService
): Promise<CustomerCatalogEntryDto[]> {
  if (pairs.length === 0) return [];

  const byId = await catalog.listByIds(pairs.map((p) => p.productId));

  return pairs.map(({ productId, at }) => ({
    productId,
    at,
    product: byId.get(productId) ?? null,
  }));
}
