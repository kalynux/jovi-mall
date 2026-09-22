import { Types } from 'mongoose';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { PriceResolverService } from '../../catalog/domain/services/pricing-inventory/PriceResolverService';
import { CartModel, ICart, ICartItem } from '../models/cart.model';
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

    /**
     * Present only on a line whose price was haggled. Same number as `price` —
     * it exists so a client can say "your agreed price" rather than "price".
     */
    negotiatedUnitPrice?: number;
    /** The lock this line will spend at checkout. The customer's own handle. */
    negotiationLockRef?: string;
  }>;
  totalItems: number;
}

/**
 * ⚠ `floor_price_snapshot` is deliberately ABSENT from `CartResponse`, and must
 * stay absent.
 *
 * It is the vendor's floor — the same secret `bargain.minPrice` is on the public
 * catalogue, and the number the bargaining agent is trusted with precisely
 * because it never leaves the negotiation. This DTO is returned verbatim by
 * `GET /customer/cart` and by every bot cart route, so a field added here is a
 * field published to the customer.
 *
 * Order creation does not need it from here either: `consume` returns the floor
 * as of the verdict, which is the authoritative one (D-10). Nothing downstream
 * has a reason to read the cart's copy.
 */

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
    currency: string = 'XAF',  // Default currency
    /**
     * A negotiated-price lock minted by the bargaining agent (optional).
     *
     * Presenting one changes two things and nothing else: the line is priced at
     * the agreed price rather than the shelf price, and the line is SET to
     * `quantity` rather than incremented — see the block below.
     *
     * It is only PEEKED here (D-12). The lock is spent at order creation, so a
     * customer may remove the line and add it again, or leave the basket
     * overnight, without losing what they haggled for.
     */
    negotiationLockRef?: string,
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
      quantity,
      ...(negotiationLockRef
        ? { negotiation: { lockRef: negotiationLockRef, customerId: userId, mode: 'peek' as const } }
        : {}),
    });

    // 5. FAIL-FAST: Digital products must have quantity = 1
    if (product.type === 'digital' && quantity !== 1) {
      throw createAppError(ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE, 400, 'Digital products can only be purchased with quantity of 1.');
    }

    // 4. Load existing cart
    let cart = await CartModel.findOne({ userId });

    const negotiated = resolvedPrice.negotiated ?? null;

    // 5. If cart exists, validate type consistency
    if (cart && cart.items.length > 0) {
      const existingType = cart.productType;

      if (existingType && existingType !== product.type) {
        throw createAppError(ERROR_CODES.CART_MIXED_PRODUCT_TYPES, 409, `Your cart contains ${existingType} products. Cannot add ${product.type} products. Please checkout or clear your cart first.`);
      }

      /**
       * Digital: V1 scope - only allow ONE digital product in cart.
       *
       * ⚠ **One exception: the SAME digital line, re-presented with a price lock.** A customer
       * who put a digital item in the basket at the shelf price and then haggled it down used to
       * be told "only one digital product at a time" about the very item the deal was on — both
       * when they pressed Lock it in and when the agent agreed it in words — and the line stayed
       * at the shelf price, so checkout charged the price they had talked their way out of. The
       * guard exists to keep a SECOND digital product out; re-pricing the one already there is
       * not that, and the existing-line branch below applies the lock to it. Without a lock the
       * re-add is still refused exactly as before.
       */
      const relockingTheSameLine = negotiated !== null
        && cart.items.length === 1
        && cart.items[0].variantId.toString() === variantId;

      if (product.type === 'digital' && !relockingTheSameLine) {
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
      if (product.type === 'digital' && !negotiated) {
        // Digital: quantity remains 1, no change
        // Just return current cart
        return this.formatCartResponse(cart);
      } else if (negotiated) {
        /**
         * A LOCKED add SETS the line; it does not increment it.
         *
         * The lock is bound to (customer, variant, quantity), so incrementing an
         * existing line produces a quantity nobody agreed a price for — and the
         * mismatch would be silent, because the peek above validated the
         * REQUESTED quantity rather than the resulting one. The negotiation was
         * about "three of these at 41 000"; that is the line.
         *
         * The discarded quantity is a real cost and it is the lesser one: the
         * alternative leaves a basket whose stated price is not the price
         * anything will honour.
         *
         * ⚠ **Digital lines take this branch too** (2026-09-22). `quantity` is
         * already proven to be 1 for a digital product (the fail-fast above), so
         * the line stays at 1 and gains the agreed price. Before this the branch was
         * unreachable for a digital line: the one-digital guard above refused the
         * re-add first, so a won bargain on it stayed at the shelf price.
         */
        cart.items[existingItemIndex].quantity = quantity;
        cart.items[existingItemIndex].price = resolvedPrice.unitPrice;
        cart.items[existingItemIndex].negotiated_unit_price = resolvedPrice.unitPrice;
        cart.items[existingItemIndex].floor_price_snapshot = negotiated.floorPrice;
        cart.items[existingItemIndex].negotiation_lock_ref = negotiated.lockRef;
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

        // Pricing. `price` carries the agreed number on a negotiated line, so
        // every existing reader — the quote, the totals, the order build — is
        // right with no edit; the three fields beside it are the provenance.
        quantity,
        price: resolvedPrice.unitPrice,
        currency,
        negotiated_unit_price: negotiated ? resolvedPrice.unitPrice : null,
        floor_price_snapshot: negotiated ? negotiated.floorPrice : null,
        negotiation_lock_ref: negotiated ? negotiated.lockRef : null,
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
   *     which is worse than either rule on its own.
   *
   *     ⚠ This bullet used to end "The price a cart quotes is re-resolved at checkout,
   *     which is the moment that actually binds." **That was false, and had been for as
   *     long as it was written.** `order.service.ts` reads `cartItem.price` — the snapshot
   *     — and never called `PriceResolverService` at all; the only other call site is
   *     `mergeCart`. Order creation now DOES re-resolve, but only the lines carrying a
   *     negotiation lock (BARGAINING-AGENT-PLAN D-12): re-resolving every line would
   *     change ordinary checkout behaviour, which nobody has asked for. So for an ordinary
   *     line the snapshot still binds, and this bullet is the whole of the rule.
   *   - **Digital lines stay at 1.** The rule is the product type's, not the endpoint's.
   *
   * `quantity: 0` is rejected rather than treated as a delete: two different intentions
   * should not share one call, and a client that computes its way to zero has a bug worth
   * surfacing. Use `DELETE /items/:variantId`.
   *
   * ⚠ **Changing the quantity DROPS a negotiated price**, and that is the one place this
   * method does refresh something. A lock is bound to (customer, variant, quantity), so
   * carrying the haggled unit price onto a quantity nobody agreed it for is exactly the
   * silent overcharge — or undercharge — the binding exists to prevent. The lock is not
   * consumed (that happens at order creation), so the customer can re-add at the agreed
   * quantity and get their price back.
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

    // A quantity change invalidates the lock's binding — see the ⚠ above. Only
    // an actual change drops it, so a client re-sending the same number (a
    // stepper double-fire, an idempotent retry) keeps the haggled price.
    if (cart.items[index].quantity !== quantity) {
      this.dropNegotiatedPrice(cart.items[index]);
    }

    cart.items[index].quantity = quantity;
    await cart.save();

    return this.formatCartResponse(cart);
  }

  /**
   * Strip a line back to an ordinary, un-negotiated one — used wherever the
   * lock's (customer, variant, quantity) binding stops holding.
   *
   * It deliberately does NOT re-resolve `price` to the list price. That would
   * make a quantity change silently more expensive at the moment the customer is
   * looking at the total, and the shelf price for a bargainable variant is a
   * question Stream D owns. The line keeps the number it was quoted and simply
   * stops claiming a negotiation produced it; the earnings split then computes
   * no uplift and no AI margin, which is the correct outcome for a line the
   * platform can no longer prove was haggled.
   *
   * Written as explicit `null`s rather than `delete`s so the sub-document is
   * written back cleared instead of keeping whatever Mongoose already had.
   */
  private dropNegotiatedPrice(item: ICartItem): void {
    item.negotiated_unit_price = null;
    item.floor_price_snapshot = null;
    item.negotiation_lock_ref = null;
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
          // ⚠ Summing changes the quantity, which breaks a lock's binding exactly as
          // `setItemQuantity` does — so the server line's negotiated price goes with it.
          // An incoming line can never CARRY one: it comes from localStorage, which is
          // client-controlled, and honouring a price from there would let anyone name
          // their own (the same argument the pricing comment below makes).
          this.dropNegotiatedPrice(cart.items[existingIndex]);
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
          negotiated_unit_price: null,
          floor_price_snapshot: null,
          negotiation_lock_ref: null,
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

        // Pricing. Note what is NOT here: `floor_price_snapshot`. See the note
        // on CartResponse — this object reaches the customer verbatim.
        quantity: item.quantity,
        price: item.price,
        currency: item.currency,
        ...(item.negotiated_unit_price != null
          ? { negotiatedUnitPrice: item.negotiated_unit_price }
          : {}),
        ...(item.negotiation_lock_ref ? { negotiationLockRef: item.negotiation_lock_ref } : {}),
      })),
      totalItems: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    };
  }

  /**
   * ── There is deliberately no `validateCheckout` here ─────────────────────────
   *
   * One used to be, with zero call sites and two debt markers inside it, and it was deleted on
   * 2026-08-19 (Phase 4, plan step 4.A.7.1). The discomfort of deleting it *is* the finding:
   * a method named `validateCheckout` that nothing calls reads, to every future author, as
   * though checkout is validated. That is the same trap as the dead `auth/guards/`, deleted
   * in the same phase for the same reason.
   *
   * Checkout validation lives on the path checkout actually takes:
   *   - the empty-cart refusal is `CartQuoteService.quote` (`CART_EMPTY_CHECKOUT`, 400);
   *   - the digital branch those markers described is already there —
   *     `cart-quote.service.ts` branches on `cart.productType === 'digital'` for the
   *     delivery-cost question, and the customer pays no delivery either way;
   *   - address usability is `assertAddressUsable`, called from the same method.
   *
   * Add a new checkout rule there, not here. A second validator that only some callers reach
   * is a rule enforced nowhere, which is what this was.
   */
}
