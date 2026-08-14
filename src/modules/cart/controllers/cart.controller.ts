import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { CartService } from '../services/cart.service';
import { cartQuoteService } from '../../orders/services/cart-quote.service';
import {
  AddToCartSchema,
  CartItemVariantParamSchema,
  MergeCartSchema,
  QuoteCartSchema,
  SetCartItemQuantitySchema,
} from '../validators/cart.validator';

const cartService = new CartService();

/**
 * Customer shopping-cart endpoints.
 *
 * The cart is keyed by the authenticated customer (role_entity id) — the same id
 * used at checkout, so a cart built here is the one POST /customer/orders/checkout
 * reads. A cart may contain items from multiple vendors (split into per-vendor
 * orders at checkout) but only one product type.
 */
export class CartController {
  /** GET /customer/cart — current cart (empty cart if none exists). */
  static getCart = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const cart = await cartService.getCart(userId);
    res.status(200).json({ success: true, data: cart });
  });

  /** POST /customer/cart/items — add a variant to the cart (or increment it). */
  static addItem = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const { productId, variantId, quantity, currency } = AddToCartSchema.parse(req.body ?? {});
    const cart = await cartService.addToCart(userId, productId, variantId, quantity, currency);
    res.status(200).json({ success: true, data: cart });
  });

  /**
   * PATCH /customer/cart/items/:variantId — set a line's quantity to an absolute value.
   *
   * The quantity stepper's endpoint. `POST /items` only ever increments, so this is what
   * makes a decrease possible at all. To remove a line, use DELETE below — `quantity: 0`
   * is a 400.
   */
  static setItemQuantity = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const { variantId } = CartItemVariantParamSchema.parse(req.params);
    const { quantity } = SetCartItemQuantitySchema.parse(req.body ?? {});
    const cart = await cartService.setItemQuantity(userId, variantId, quantity);
    res.status(200).json({ success: true, data: cart });
  });

  /**
   * DELETE /customer/cart/items/variant/:variantId — remove ONE line.
   *
   * Nested under `/variant/` rather than sharing `/items/:id` with the product-keyed route
   * below: two DELETEs on one path shape, distinguished only by which kind of id you sent,
   * is a footgun — a client sending the wrong one gets a silent mass-delete instead of an
   * error. The path says which key it takes.
   */
  static removeVariant = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const { variantId } = CartItemVariantParamSchema.parse(req.params);
    const cart = await cartService.removeVariantFromCart(userId, variantId);
    res.status(200).json({ success: true, data: cart });
  });

  /**
   * POST /customer/cart/merge — hand an anonymous cart over at sign-in.
   *
   * Unusable lines are **reported, not thrown**: `meta.dropped[]` names each one and why,
   * so the UI can say what it could not carry over rather than losing the basket to
   * explain one bad line. See `CartService.mergeCart`.
   */
  static mergeCart = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const { items, strategy } = MergeCartSchema.parse(req.body ?? {});
    const { cart, dropped } = await cartService.mergeCart(userId, items, strategy);
    res.status(200).json({ success: true, data: cart, meta: { dropped } });
  });

  /**
   * POST /customer/cart/quote — what this cart will cost, before checking out.
   *
   * `delivery` is `0` and `total` is the subtotal, because the **vendor** absorbs the
   * agency's delivery fee — see `CartQuoteService`. The real fee is reported as
   * `absorbedByVendor` so the UI can say "delivery included" and mean it.
   *
   * Passing `deliveryAddressId` also validates it, which is the point: an address typed by
   * hand rather than picked from `GET /api/geo/search` has no geocoded location and
   * checkout will refuse it. Far better to learn that here than at the pay button.
   */
  static quoteCart = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const { deliveryAddressId } = QuoteCartSchema.parse(req.body ?? {});
    const quote = await cartQuoteService.quoteForCustomer(userId, deliveryAddressId);
    res.status(200).json({ success: true, data: quote });
  });

  /**
   * DELETE /customer/cart/items/:productId — remove a product from the cart.
   *
   * ⚠️ Removes **every variant** of that product. Kept for back-compat; a cart row should
   * call the variant-keyed route above, or removing one size of a T-shirt removes them all.
   */
  static removeItem = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    const cart = await cartService.removeFromCart(userId, req.params.productId);
    res.status(200).json({ success: true, data: cart });
  });

  /** DELETE /customer/cart — empty the cart. */
  static clearCart = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.role_entity._id.toString();
    await cartService.clearCart(userId);
    res.status(200).json({ success: true, message: 'Cart cleared' });
  });
}
