import { Types } from 'mongoose';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { PriceResolverService } from '../../catalog/domain/services/pricing-inventory/PriceResolverService';
import { CartModel, ICart } from '../models/cart.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * CartService - Shopping cart management
 * 
 * BUSINESS RULES:
 * - Cart can only contain ONE product type (physical OR digital, NEVER service)
 * - Digital products: quantity MUST = 1 (fail-fast, no silent correction)
 * - Digital products: only ONE product per cart (v1 scope)
 * - Service products: blocked from cart (use booking system)
 * 
 * VARIANT-FIRST ARCHITECTURE:
 * - variantId is REQUIRED for all cart operations
 * - The variant is the sellable unit, not the product
 * - All snapshots prioritize variant data (SKU, options, price)
 */

export interface CartResponse {
  cartId?: string;   // Cart document _id — snapshotted onto orders as the checkout-group key
  userId: string;
  productType?: string;
  items: Array<{
    // Variant data (first-class)
    variantId: string;
    sku: string;
    variantTitle?: string;
    optionsSnapshot: string;

    // Product data (context)
    productId: string;
    title: string;
    vendorId: string;
    productType: 'physical' | 'digital';

    // Pricing
    quantity: number;
    price: number;
    currency: string;
  }>;
  totalItems: number;
}

/**
 * How an anonymous cart is reconciled with a signed-in one.
 *
 * `sum` is the default because it matches what a shopper means — both carts are theirs.
 * `replace` and `keep_server` exist for a client that has already asked the shopper which
 * one they want; the API does not guess.
 */
export type CartMergeStrategy = 'sum' | 'replace' | 'keep_server';

/**
 * Why one incoming line did not survive the merge.
 *
 * Reported rather than thrown — see `mergeCart`. The codes are deliberately coarse: a
 * shopper does not need to know whether a product was archived, suspended or soft-deleted,
 * only that it is no longer for sale.
 */
export interface CartMergeDropped {
  variantId: string;
  reason:
  | 'PRODUCT_UNAVAILABLE'
  | 'PRODUCT_TYPE_CONFLICT'
  | 'DIGITAL_LIMIT_REACHED'
  | 'SERVICE_NOT_ALLOWED'
  | 'SERVER_CART_KEPT';
}

export class CartService {
  private productRepository: ProductRepositoryMongo;
  private variantRepository: VariantRepositoryMongo;
  private priceResolverService: PriceResolverService;

  constructor() {
    this.productRepository = new ProductRepositoryMongo();
    this.variantRepository = new VariantRepositoryMongo();
    this.priceResolverService = new PriceResolverService(
      this.productRepository,
      this.variantRepository
    );
  }

  /**
   * Adds a product to the user's cart.
   * 
   * VALIDATION:
   * - Service products → rejected (use booking)
   * - Mixed product types → rejected
   * - Digital: quantity > 1 → rejected (fail-fast)
   * - Digital: multiple products → rejected (v1 scope)
   * 
   * @param userId - User ID
   * @param productId - Product to add
   * @param quantity - Quantity to add
   * @returns Updated cart
   * @throws ValidationError on business rule violation
   */
  async addToCart(
    userId: string,
    productId: string,
    variantId: string,
    quantity: number,
    currency: string = 'XAF'  // Default currency
  ): Promise<CartResponse> {
    // 1. ENFORCE: variantId is REQUIRED (variant-first architecture)
    if (!variantId) {
      throw createAppError(ERROR_CODES.CART_VARIANT_REQUIRED, 400, 'variantId is required. The variant is the sellable unit.');
    }

    // 2. Fetch product to validate type
    const product = await this.productRepository.findByIdUnscoped(productId);

    if (!product) {
      throw createAppError(ERROR_CODES.CART_PRODUCT_NOT_FOUND, 404, `Product ${productId} not found`);
    }

    // 3. Block service products from cart (defense in depth)
    if (product.type === 'service') {
      throw createAppError(ERROR_CODES.CART_SERVICE_PRODUCT_NOT_ALLOWED, 400, 'Service products cannot be added to cart. Please use the booking system instead.');
    }

    // 4. Get variant and validate
    const variant = await this.variantRepository.findById(variantId);
    if (!variant) {
      throw createAppError(ERROR_CODES.CART_VARIANT_NOT_FOUND, 404, `Variant ${variantId} not found`);
    }

    // Validate variant belongs to product
    if (variant.productId !== productId) {
      throw createAppError(ERROR_CODES.CART_VARIANT_PRODUCT_MISMATCH, 400, 'Variant does not belong to this product');
    }

    // Resolve price using PriceResolverService 
    const resolvedPrice = await this.priceResolverService.execute({
      productId,
      variantId,
      vendorId: product.vendorId,
      quantity
    });

    // 5. FAIL-FAST: Digital products must have quantity = 1
    if (product.type === 'digital' && quantity !== 1) {
      throw createAppError(ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE, 400, 'Digital products can only be purchased with quantity of 1.');
    }

    // 4. Load existing cart
    let cart = await CartModel.findOne({ userId });

    // 5. If cart exists, validate type consistency
    if (cart && cart.items.length > 0) {
      const existingType = cart.productType;

      if (existingType && existingType !== product.type) {
        throw createAppError(ERROR_CODES.CART_MIXED_PRODUCT_TYPES, 409, `Your cart contains ${existingType} products. Cannot add ${product.type} products. Please checkout or clear your cart first.`);
      }

      // Digital: V1 scope - only allow ONE digital product in cart
      if (product.type === 'digital') {
        throw createAppError(ERROR_CODES.CART_DIGITAL_LIMIT_REACHED, 409, 'Only one digital product can be added to cart at a time. Please checkout or clear your cart first.');
      }
    }

    // 6. Create cart if doesn't exist
    if (!cart) {
      cart = new CartModel({
        userId,
        productType: product.type as 'physical' | 'digital',
        items: [],
      });
    }

    // 7. Generate variant title for display
    const variantTitle = this.generateVariantTitle(variant.optionSignature);

    // 8. Check if variant already in cart (check by variantId, not productId)
    const existingItemIndex = cart.items.findIndex(
      (item) => item.variantId.toString() === variantId
    );

    if (existingItemIndex !== -1) {
      // Variant already in cart
      if (product.type === 'digital') {
        // Digital: quantity remains 1, no change
        // Just return current cart
        return this.formatCartResponse(cart);
      } else {
        // Physical: increment quantity
        cart.items[existingItemIndex].quantity += quantity;
      }
    } else {
      // Add new item with comprehensive snapshot (VARIANT-FIRST)
      cart.items.push({
        // Variant data (first-class)
        variantId: new Types.ObjectId(variantId),
        sku: variant.sku,
        variantTitle,
        optionsSnapshot: variant.optionSignature,

        // Product data (context)
        productId: new Types.ObjectId(product.id),
        title: product.title,
        vendorId: new Types.ObjectId(product.vendorId),
        productType: product.type as 'physical' | 'digital',

        // Pricing
        quantity,
        price: resolvedPrice.unitPrice,
        currency,
      });
    }

    // 8. Memoize product type for fast checking
    cart.productType = product.type;

    await cart.save();

    return this.formatCartResponse(cart);
  }

  /**
   * Set a line's quantity to an ABSOLUTE value.
   *
   * `addToCart` does `quantity += quantity`, so before this there was no way to *decrease*
   * a line or to set one directly — the quantity stepper on the cart page could increment
   * and nothing else. This is that missing half, not a replacement: `POST /items` keeps its
   * increment semantics, which is what "add to cart" means from a product page.
   *
   * Two behaviours are inherited from the increment path on purpose:
   *
   *   - **The snapshot price is not refreshed.** `addToCart` only resolves a price when it
   *     *inserts* a line; incrementing an existing one leaves the original. Re-resolving
   *     here would mean the same button changes the price on one path and not the other,
   *     which is worse than either rule on its own. The price a cart quotes is re-resolved
   *     at checkout, which is the moment that actually binds.
   *   - **Digital lines stay at 1.** The rule is the product type's, not the endpoint's.
   *
   * `quantity: 0` is rejected rather than treated as a delete: two different intentions
   * should not share one call, and a client that computes its way to zero has a bug worth
   * surfacing. Use `DELETE /items/:variantId`.
   */
  async setItemQuantity(
    userId: string,
    variantId: string,
    quantity: number,
  ): Promise<CartResponse> {
    const cart = await CartModel.findOne({ userId });
    if (!cart) {
      throw createAppError(ERROR_CODES.CART_NOT_FOUND, 404, 'Cart not found');
    }

    // Same matcher `addToCart` uses — cart items carry no `_id` (CartItemSchema is
    // `{ _id: false }`), so the variant is the only key a line can be addressed by.
    const index = cart.items.findIndex((item) => item.variantId.toString() === variantId);
    if (index === -1) {
      throw createAppError(
        ERROR_CODES.CART_ITEM_NOT_FOUND,
        404,
        'That item is no longer in your cart.',
        { variantId },
      );
    }

    if (cart.items[index].productType === 'digital' && quantity !== 1) {
      throw createAppError(
        ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE,
        400,
        'Digital products can only be purchased with quantity of 1.',
      );
    }

    cart.items[index].quantity = quantity;
    await cart.save();

    return this.formatCartResponse(cart);
  }

  /**
   * Remove ONE line, keyed on the variant.
   *
   * `removeFromCart` below filters on `productId`, so removing one size of a T-shirt
   * removes every size of it — the per-line remove button could not be built against it.
   * Both exist: the product-keyed route is kept for back-compat (it is a documented
   * endpoint with live callers), and this is the one a cart row should call.
   */
  async removeVariantFromCart(userId: string, variantId: string): Promise<CartResponse> {
    const cart = await CartModel.findOne({ userId });
    if (!cart) {
      throw createAppError(ERROR_CODES.CART_NOT_FOUND, 404, 'Cart not found');
    }

    const before = cart.items.length;
    cart.items = cart.items.filter((item) => item.variantId.toString() !== variantId);

    if (cart.items.length === before) {
      throw createAppError(
        ERROR_CODES.CART_ITEM_NOT_FOUND,
        404,
        'That item is no longer in your cart.',
        { variantId },
      );
    }

    // `undefined` rather than null, matching removeFromCart: the schema path defaults to
    // null and Mongoose treats an undefined assignment as an unset, which is what an empty
    // cart should look like — the same document a cart that never held anything has.
    if (cart.items.length === 0) {
      cart.productType = undefined;
    }

    await cart.save();

    return this.formatCartResponse(cart);
  }

  /**
   * Removes a product from cart.
   * @param userId - User ID
   * @param productId - Product to remove
   */
  async removeFromCart(userId: string, productId: string): Promise<CartResponse> {
    const cart = await CartModel.findOne({ userId });

    if (!cart) {
      throw createAppError(ERROR_CODES.CART_NOT_FOUND, 404, 'Cart not found');
    }

    // Remove item
    cart.items = cart.items.filter(
      (item) => item.productId.toString() !== productId
    );

    // Reset product type if cart is now empty
    if (cart.items.length === 0) {
      cart.productType = undefined;
    }

    await cart.save();

    return this.formatCartResponse(cart);
  }

  /**
   * Hand an anonymous cart over at sign-in.
   *
   * Checkout requires an account, but browsing does not — so a visitor fills a cart in
   * `localStorage`, signs in at checkout, and must not lose it. This is the one-time
   * handover, and it is deliberately the only write on this service that **reports**
   * failures instead of throwing them.
   *
   * ── Why lines are dropped, not refused ──────────────────────────────────────
   *
   * Every other cart write is a single deliberate action, so a 4xx is the right answer:
   * the shopper asked for one thing and it could not be done. A merge is a *batch* the
   * shopper never itemised — they added a T-shirt last Tuesday and a product that has
   * since been unpublished, and throwing `CART_MIXED_PRODUCT_TYPES` at sign-in would lose
   * the whole basket to explain one bad line. So unusable lines are dropped and returned
   * in `meta.dropped[]`, and the UI can say which — silently losing a line is exactly what
   * this endpoint exists to prevent.
   *
   * ── The server cart wins ────────────────────────────────────────────────────
   *
   * On a type conflict the *server* cart is authoritative and the incoming lines are
   * dropped. That is not arbitrary: the server cart was built while signed in, so it is
   * the one the shopper has seen on more than one device, and it is the one an in-flight
   * checkout would be reading.
   */
  async mergeCart(
    userId: string,
    incoming: Array<{ productId: string; variantId: string; quantity: number }>,
    strategy: CartMergeStrategy = 'sum',
  ): Promise<{ cart: CartResponse; dropped: CartMergeDropped[] }> {
    const dropped: CartMergeDropped[] = [];
    const cart = (await CartModel.findOne({ userId })) ?? new CartModel({ userId, items: [] });

    // `replace` starts from an empty server cart, so the incoming set defines both the
    // contents and the product type. It is the only strategy where the server cart's
    // existing type does not constrain the merge.
    if (strategy === 'replace') {
      cart.items = [];
      cart.productType = undefined;
    }

    // `keep_server` is a no-op against a non-empty cart — by definition. Reported rather
    // than silently ignored so the client can tell "your saved cart was kept" from
    // "nothing you sent was usable".
    if (strategy === 'keep_server' && cart.items.length > 0) {
        for (const line of incoming) {
            dropped.push({ variantId: line.variantId, reason: 'SERVER_CART_KEPT' });
        }
        return { cart: this.formatCartResponse(cart), dropped };
    }

    for (const line of incoming) {
      // ── Is this still a thing anyone may buy? ────────────────────────────────
      const product = await this.productRepository.findByIdUnscoped(line.productId);
      if (!product) {
        dropped.push({ variantId: line.variantId, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }
      if (product.type === 'service') {
        dropped.push({ variantId: line.variantId, reason: 'SERVICE_NOT_ALLOWED' });
        continue;
      }

      const variant = await this.variantRepository.findById(line.variantId);
      if (!variant || variant.productId !== line.productId) {
        dropped.push({ variantId: line.variantId, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }

      // `PriceResolverService` is what enforces `product.status === 'active'` and
      // `variant.status === 'active'` — the same gate `addToCart` relies on. A throw here
      // means the product left the catalogue while the cart sat in localStorage, which is
      // precisely the case this endpoint exists to report rather than crash on.
      let unitPrice: number;
      try {
        const resolved = await this.priceResolverService.execute({
          productId: line.productId,
          variantId: line.variantId,
          vendorId: product.vendorId,
          quantity: line.quantity,
        });
        unitPrice = resolved.unitPrice;
      } catch {
        dropped.push({ variantId: line.variantId, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }

      // ── Does it fit alongside what is already here? ──────────────────────────
      const effectiveType = cart.productType ?? (cart.items.length > 0 ? cart.items[0].productType : undefined);

      if (effectiveType && effectiveType !== product.type) {
        dropped.push({ variantId: line.variantId, reason: 'PRODUCT_TYPE_CONFLICT' });
        continue;
      }

      const quantity = product.type === 'digital' ? 1 : line.quantity;

      if (product.type === 'digital') {
        const alreadyHasDigital = cart.items.length > 0;
        const sameVariantAlready = cart.items.some((i) => i.variantId.toString() === line.variantId);
        // One digital product per cart (v1 scope), and a second copy of the same one is
        // not a quantity — a licence bought twice is still one licence.
        if (alreadyHasDigital && !sameVariantAlready) {
          dropped.push({ variantId: line.variantId, reason: 'DIGITAL_LIMIT_REACHED' });
          continue;
        }
        if (sameVariantAlready) continue;
      }

      const existingIndex = cart.items.findIndex((i) => i.variantId.toString() === line.variantId);
      if (existingIndex !== -1) {
        // `sum` is the default because it matches what a shopper means: the two carts are
        // both theirs, and two of a thing in each is four.
        if (product.type !== 'digital') {
          cart.items[existingIndex].quantity += quantity;
        }
      } else {
        cart.items.push({
          variantId: new Types.ObjectId(line.variantId),
          sku: variant.sku,
          variantTitle: this.generateVariantTitle(variant.optionSignature),
          optionsSnapshot: variant.optionSignature,
          productId: new Types.ObjectId(product.id),
          title: product.title,
          vendorId: new Types.ObjectId(product.vendorId),
          productType: product.type as 'physical' | 'digital',
          quantity,
          // Priced NOW, not from whatever the anonymous cart carried. A localStorage cart
          // is client-controlled data: trusting its price would let anyone name their own.
          price: unitPrice,
          currency: 'XAF',
        });
        cart.productType = product.type as 'physical' | 'digital';
      }
    }

    if (cart.items.length === 0) {
      cart.productType = undefined;
    }

    await cart.save();

    return { cart: this.formatCartResponse(cart), dropped };
  }

  /**
   * Gets user's cart.
   * @param userId - User ID
   * @returns Cart contents
   */
  async getCart(userId: string): Promise<CartResponse> {
    const cart = await CartModel.findOne({ userId });

    if (!cart) {
      // Return empty cart
      return {
        userId,
        items: [],
        totalItems: 0,
      };
    }

    return this.formatCartResponse(cart);
  }

  /**
   * Clears user's cart.
   * @param userId - User ID
   */
  async clearCart(userId: string): Promise<void> {
    await CartModel.deleteOne({ userId });
  }

  /**
   * Format cart for API response
   */
  /**
   * Generate human-readable variant title from optionSignature
   * Examples:
   *   "default" → ""
   *   "size:large" → "Size: Large"
   *   "size:large|color:red" → "Size: Large, Color: Red"
   */
  private generateVariantTitle(optionSignature: string): string {
    if (!optionSignature || optionSignature === 'default') {
      return '';
    }

    // Option-less variants (e.g. digital) carry a non-"key:value" signature (the SKU),
    // so only format genuine "key:value" pairs and drop anything that isn't one.
    return optionSignature
      .split('|')
      .map(pair => {
        const [key, value] = pair.split(':');
        if (!key || !value) return null;
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        const capitalizedValue = value.charAt(0).toUpperCase() + value.slice(1);
        return `${capitalizedKey}: ${capitalizedValue}`;
      })
      .filter((pair): pair is string => pair !== null)
      .join(', ');
  }

  /**
   * Format cart for API response
   */
  private formatCartResponse(cart: ICart): CartResponse {
    return {
      cartId: (cart as any)._id?.toString(),
      userId: cart.userId,
      productType: cart.productType,
      items: cart.items.map((item) => ({
        // Variant data
        variantId: item.variantId.toString(),
        sku: item.sku,
        variantTitle: item.variantTitle,
        optionsSnapshot: item.optionsSnapshot,

        // Product data
        productId: item.productId.toString(),
        title: item.title,
        vendorId: item.vendorId.toString(),
        productType: item.productType,

        // Pricing
        quantity: item.quantity,
        price: item.price,
        currency: item.currency,
      })),
      totalItems: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  // TODO: Add checkout validation guards
  /**
   * Validate cart before checkout
   * 
   * CHECKOUT CONSTRAINTS:
   * - Digital products: no shipping address required
   * - Digital products: no shipping fee
   * - Digital products: skip shipping calculation pipeline
   * 
   * @param userId - User ID
   * @throws ValidationError if cart invalid for checkout
   */
  async validateCheckout(userId: string): Promise<void> {
    const cart = await CartModel.findOne({ userId });

    if (!cart || cart.items.length === 0) {
      throw createAppError(ERROR_CODES.CART_EMPTY_CHECKOUT, 400, 'Cannot checkout empty cart');
    }

    // TODO: Add shipping constraints for digital products
    // if (cart.productType === 'digital') {
    //   // Skip shipping address validation
    //   // Skip shipping fee calculation
    //   // Skip shipping method selection
    // }
  }
}
