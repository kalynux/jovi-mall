import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { CartService } from '../services/cart.service';
import { AddToCartSchema } from '../validators/cart.validator';

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

  /** DELETE /customer/cart/items/:productId — remove a product from the cart. */
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
