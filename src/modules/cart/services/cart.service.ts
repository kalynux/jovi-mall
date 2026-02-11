import { Types } from 'mongoose';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { PriceResolverService } from '../../catalog/domain/services/pricing-inventory/PriceResolverService';
import { CartModel, ICart } from '../models/cart.model';
import { ValidationError } from '../../../core/errors';

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
      throw new ValidationError(
        'VARIANT_REQUIRED: variantId is required. The variant is the sellable unit.'
      );
    }

    // 2. Fetch product to validate type
    const product = await this.productRepository.findByIdUnscoped(productId);

    if (!product) {
      throw new ValidationError(`Product ${productId} not found`);
    }

    // 3. Block service products from cart (defense in depth)
    if (product.type === 'service') {
      throw new ValidationError(
        'SERVICE_PRODUCTS_MUST_BE_BOOKED: Service products cannot be added to cart. Please use the booking system instead.'
      );
    }

    // 4. Get variant and validate
    const variant = await this.variantRepository.findById(variantId);
    if (!variant) {
      throw new ValidationError(`Variant ${variantId} not found`);
    }

    // Validate variant belongs to product
    if (variant.productId !== productId) {
      throw new ValidationError(`Variant does not belong to this product`);
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
      throw new ValidationError(
        'DIGITAL_QUANTITY_MUST_BE_ONE: Digital products can only be purchased with quantity of 1.'
      );
    }

    // 4. Load existing cart
    let cart = await CartModel.findOne({ userId });

    // 5. If cart exists, validate type consistency
    if (cart && cart.items.length > 0) {
      const existingType = cart.productType;

      if (existingType && existingType !== product.type) {
        throw new ValidationError(
          `CART_MIXED_PRODUCT_TYPES_NOT_ALLOWED: Your cart contains ${existingType} products. Cannot add ${product.type} products. Please checkout or clear your cart first.`
        );
      }

      // Digital: V1 scope - only allow ONE digital product in cart
      if (product.type === 'digital') {
        throw new ValidationError(
          'DIGITAL_CART_LIMIT_REACHED: Only one digital product can be added to cart at a time. Please checkout or clear your cart first.'
        );
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
   * Removes a product from cart.
   * @param userId - User ID
   * @param productId - Product to remove
   */
  async removeFromCart(userId: string, productId: string): Promise<CartResponse> {
    const cart = await CartModel.findOne({ userId });

    if (!cart) {
      throw new ValidationError('Cart not found');
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
    if (optionSignature === 'default') {
      return '';
    }

    return optionSignature
      .split('|')
      .map(pair => {
        const [key, value] = pair.split(':');
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        const capitalizedValue = value.charAt(0).toUpperCase() + value.slice(1);
        return `${capitalizedKey}: ${capitalizedValue}`;
      })
      .join(', ');
  }

  /**
   * Format cart for API response
   */
  private formatCartResponse(cart: ICart): CartResponse {
    return {
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
      throw new ValidationError('Cannot checkout empty cart');
    }

    // TODO: Add shipping constraints for digital products
    // if (cart.productType === 'digital') {
    //   // Skip shipping address validation
    //   // Skip shipping fee calculation
    //   // Skip shipping method selection
    // }
  }
}
