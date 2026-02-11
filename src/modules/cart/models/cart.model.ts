import mongoose, { Schema, model, Types } from 'mongoose';

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
    ref: 'ProductVariant', 
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
    ref: 'Product', 
    required: true 
  },
  title: { 
    type: String, 
    required: true 
  },
  vendorId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Vendor', 
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
  model<ICart>('Cart', CartSchema);
