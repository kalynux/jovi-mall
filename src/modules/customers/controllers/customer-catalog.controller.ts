import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { wishlistService } from '../services/wishlist.service';
import { recentlyViewedService } from '../services/recently-viewed.service';
import {
  AddWishlistItemSchema,
  CustomerCatalogListQuerySchema,
  ProductIdParamSchema,
  RecordProductViewSchema,
  SavedAmongSchema,
} from '../validators/customer-catalog.validator';

/**
 * A customer's own lists of products — saved, and recently viewed (Phase 6 · 6.E.1 / 6.E.2).
 *
 * Both surfaces are mounted under `/api/customer`, behind `requireAuth` +
 * `requireRole(['customer'])` on that router. Every handler resolves the owner from
 * `req.auth.role_entity._id` — the **customer** id, not the user id — and never from a
 * body or a path segment. That is what makes the whole file owner-scoped by construction:
 * there is no parameter a caller could set to reach somebody else's list.
 *
 * ⚠ These are the customer-scoped mirror of `/api/public/products`, and the product cards
 * they return are built by the **same** projection (`PublicProductListItemDto`). Do not
 * grow a second product shape here — the stock-semantics trap in `api-doc/public/catalog.md`
 * (`inStock` is a boolean and never a count, because nothing decrements stock until
 * checkout commits) is exactly the kind of thing two shapes disagree about.
 */

/** The customer this request belongs to. Never a body field, never a path segment. */
function customerIdOf(req: Request): string {
  return req.auth!.role_entity._id.toString();
}

export class CustomerCatalogController {
  // ── Wishlist ──────────────────────────────────────────────────────────────

  /** GET /api/customer/wishlist — saved products, newest save first. */
  static listWishlist = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = CustomerCatalogListQuerySchema.parse(req.query);
    const { data, meta } = await wishlistService.list(customerIdOf(req), page, limit);
    sendSuccess(res, data, { meta });
  });

  /**
   * POST /api/customer/wishlist — save a product.
   *
   * **200, not 201, and idempotent.** Saving something already saved is not an error and not
   * a new resource: from the customer's side "it is saved" was already true, and answering
   * 409 turns a double-tap into a visible failure for an operation that succeeded.
   */
  static addWishlistItem = asyncHandler(async (req: Request, res: Response) => {
    const input = AddWishlistItemSchema.parse(req.body);
    const entry = await wishlistService.add(customerIdOf(req), input.productId);
    sendSuccess(res, entry, { message: 'Saved to your wishlist.' });
  });

  /** DELETE /api/customer/wishlist/:productId — remove a save. 404 if it is not on the list. */
  static removeWishlistItem = asyncHandler(async (req: Request, res: Response) => {
    const { productId } = ProductIdParamSchema.parse(req.params);
    await wishlistService.remove(customerIdOf(req), productId);
    sendSuccess(res, null, { message: 'Removed from your wishlist.' });
  });

  /**
   * POST /api/customer/wishlist/saved-among — which of these are saved?
   *
   * One call per rendered grid, rather than one per card. A POST because a page of 100 ids
   * is ~2.5 KB of query string; it reads and writes nothing.
   */
  static savedAmong = asyncHandler(async (req: Request, res: Response) => {
    const input = SavedAmongSchema.parse(req.body);
    const savedProductIds = await wishlistService.savedAmong(customerIdOf(req), input.productIds);
    sendSuccess(res, { savedProductIds });
  });

  // ── Recently viewed ───────────────────────────────────────────────────────

  /** GET /api/customer/recently-viewed — most recently opened first. */
  static listRecentlyViewed = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = CustomerCatalogListQuerySchema.parse(req.query);
    const { data, meta } = await recentlyViewedService.list(customerIdOf(req), page, limit);
    sendSuccess(res, data, { meta });
  });

  /**
   * POST /api/customer/recently-viewed — record that a product was opened.
   *
   * Carries no timestamp: the list is ordered and capped by this value, so a client-supplied
   * one would be a client-chosen position in a bounded list. The schema has no such field.
   */
  static recordView = asyncHandler(async (req: Request, res: Response) => {
    const input = RecordProductViewSchema.parse(req.body);
    const entry = await recentlyViewedService.record(customerIdOf(req), input.productId);
    sendSuccess(res, entry);
  });

  /** DELETE /api/customer/recently-viewed — forget everything. */
  static clearRecentlyViewed = asyncHandler(async (req: Request, res: Response) => {
    const result = await recentlyViewedService.clear(customerIdOf(req));
    sendSuccess(res, result, { message: 'Your recently-viewed list has been cleared.' });
  });
}
