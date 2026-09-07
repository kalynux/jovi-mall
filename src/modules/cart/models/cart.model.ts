import mongoose, { Schema, model, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Cart Model
 * 
 * Represents a customer's shopping cart.
 * 
 * BUSINESS RULES:
 * - Cart can only contain ONE product type (physical OR digital, NEVER service)
 * - Digital products: quantity always = 1
 * - Service products: blocked from cart (use booking system)
 * 
 * VARIANT-FIRST ARCHITECTURE:
 * - The VARIANT is the sellable unit, not the product
 * - variantId is REQUIRED for all cart items
 * - All pricing, inventory, and SKU data comes from variant
 */

export interface ICartItem {
  // === VARIANT DATA (First-class, required) ===
  variantId: Types.ObjectId;          // REQUIRED - the sellable unit
  sku: string;                        // Variant SKU snapshot
  variantTitle?: string;              // Display title (e.g., "Size: Large, Color: Red")
  optionsSnapshot: string;            // Copy of variant's optionSignature
  
  // === PRODUCT DATA (Context) ===
  productId: Types.ObjectId;          // Parent product reference
  title: string;                      // Product title snapshot
  vendorId: Types.ObjectId;           // Vendor reference snapshot
  productType: 'physical' | 'digital'; // NEVER 'service'
  
  // === PRICING ===
  quantity: number;                   // Quantity in cart
  price: number;                      // Unit price snapshot
  currency: string;                   // Currency code (e.g., 'XAF', 'USD')

  // === NEGOTIATED PRICE (bargaining agent — optional, absent on an ordinary line) ===
  /**
   * The price the customer haggled to, and the marker that this line WAS
   * haggled. `price` above carries the same number so every existing reader
   * (the cart quote, the order build, the totals) is correct with no edit; this
   * field is what says the number came from a negotiation rather than a shelf.
   *
   * Absent = an ordinary line at the list price.
   */
  negotiated_unit_price?: number | null;
  /**
   * The vendor's floor at the moment the lock was honoured — the number the
   * platform's AI margin is a share of the uplift OVER.
   *
   * ⚠ Snapshotted rather than re-read: the vendor may edit `variant.price` at
   * any time, and re-reading at split time would compute a share of an uplift
   * nobody agreed to. Note the ORDER item's copy is taken from the consume
   * verdict rather than from here (see `order.service.ts`) — this one is the
   * add-to-cart record, and the two can legitimately differ if the vendor moved
   * the window in between.
   *
   * ⚠ Never surfaced to a customer. It is the vendor's floor, the same secret
   * `bargain.minPrice` is on the public catalogue.
   */
  floor_price_snapshot?: number | null;
  /**
   * The lock this line is spending, carried so order creation can CONSUME it
   * (D-12 — add-to-cart only peeks).
   *
   * The line keeps it after checkout fails, which is the point: a failed order
   * has not burned the lock, so the customer's next attempt still gets their
   * price.
   */
  negotiation_lock_ref?: string | null;
}

export interface ICart {
  userId: string;                                    // Customer/user ID
  productType?: 'physical' | 'digital' | 'service'; // Memoized for fast type checking
  items: ICartItem[];
  createdAt: Date;
  updatedAt: Date;
}

const CartItemSchema = new Schema<ICartItem>({
  // Variant data (first-class)
  variantId: { 
    type: Schema.Types.ObjectId, 
    ref: MODELS.PRODUCT_VARIANT, 
    required: true  // REQUIRED - variant is the sellable unit
  },
  sku: { 
    type: String, 
    required: true 
  },
  variantTitle: { 
    type: String 
  },
  optionsSnapshot: { 
    type: String, 
    required: true,
    default: 'default'
  },
  
  // Product data (context)
  productId: { 
    type: Schema.Types.ObjectId, 
    ref: MODELS.PRODUCT, 
    required: true 
  },
  title: { 
    type: String, 
    required: true 
  },
  vendorId: { 
    type: Schema.Types.ObjectId, 
    ref: MODELS.VENDOR, 
    required: true 
  },
  productType: { 
    type: String, 
    enum: ['physical', 'digital'], // Service products BLOCKED
    required: true 
  },
  
  // Pricing
  quantity: { 
    type: Number, 
    required: true, 
    min: 1 
  },
  price: { 
    type: Number, 
    required: true, 
    min: 0 
  },
  currency: {
    type: String,
    required: true,
    default: 'XAF'  // Default currency
  },

  // Negotiated price — see ICartItem. All three are absent on an ordinary line;
  // `default: null` rather than `undefined` so a line that LOSES its negotiation
  // (a quantity change — see setItemQuantity) is written back as explicitly
  // un-negotiated rather than leaving a stale value behind.
  negotiated_unit_price: {
    type: Number,
    default: null,
    min: 0
  },
  floor_price_snapshot: {
    type: Number,
    default: null,
    min: 0
  },
  negotiation_lock_ref: {
    type: String,
    default: null
  },
}, { _id: false });

const CartSchema = new Schema<ICart>({
  userId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  productType: { 
    type: String, 
    enum: ['physical', 'digital'],  // Service products NEVER allowed in cart
    default: null
  },
  items: [CartItemSchema],
}, {
  timestamps: true,
});

export const CartModel = 
  (mongoose.models.Cart as mongoose.Model<ICart>) || 
  model<ICart>(MODELS.CART, CartSchema, COLLECTIONS.CART);
