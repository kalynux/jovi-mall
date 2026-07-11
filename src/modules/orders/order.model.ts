import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

/**
 * Order Model
 * 
 * Represents a customer order created from cart.
 * 
 * BUSINESS RULES:
 * - Orders can ONLY be 'physical' or 'digital' (NEVER 'service')
 * - Service products use booking module, not orders
 * - Physical orders have delivery tracking
 * - Digital orders have NO delivery (entitlements instead)
 * 
 * VARIANT-FIRST ARCHITECTURE:
 * - variant_id is REQUIRED (the variant is the sellable unit)
 * - All order items snapshot variant data (SKU, options, price)
 * 
 * PAYMENT-READY:
 * - Tracks payment and fulfillment status separately
 * - Idempotent payment handling
 * - Price breakdown for tax audits
 */

export type OrderType = 'physical' | 'digital';
export type PaymentStatus = 'pending' | 'AWAITING_PAYMENT' | 'paid' | 'disputed' | 'failed' | 'refunded';
/**
 * 'partially_shipped' / 'partially_delivered' / 'shipped' / 'delivered' are
 * system-derived from the order's shipments (see OrderFulfillmentAggregationService)
 * — never set directly by a vendor. Vendors only drive pending/processing/cancelled.
 */
export type FulfillmentStatus = 'pending' | 'processing' | 'partially_shipped' | 'shipped' | 'partially_delivered' | 'delivered' | 'fulfilled' | 'cancelled' | 'returned';

export interface IPriceBreakdown {
  base: number;      // Subtotal before tax/discount
  tax: number;       // Tax amount
  discount: number;  // Discount amount
  total: number;     // Final total
}

export interface IOrderItem {
  _id: mongoose.Types.ObjectId;

  // === VARIANT DATA (First-class, required) ===
  variant_id: mongoose.Types.ObjectId;  // REQUIRED - the sellable unit
  sku: string;                          // Variant SKU snapshot
  variant_title?: string;               // Display title
  options_snapshot: string;             // Copy of variant's optionSignature

  // === PRODUCT DATA (Context) ===
  product_id: mongoose.Types.ObjectId;  // Parent product reference
  title: string;                        // Product title snapshot
  vendor_id: mongoose.Types.ObjectId;   // Vendor reference snapshot
  product_type: 'physical' | 'digital'; // NEVER 'service'

  // === PRICING ===
  quantity: number;                     // Quantity ordered
  price: number;                        // Unit price at time of order
  currency: string;                     // Currency code

  // === DELIVERY (Optional - only for physical products) ===
  delivery?: {
    agency_id: mongoose.Types.ObjectId;
    shipment_id?: mongoose.Types.ObjectId | null;
    status: 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'agent_delivered' | 'delivered' | 'failed' | 'returned' | 'rejected' | 'pending_agency_reassignment';
    free_delivery: boolean;
    /**
     * Set when `status` is forced to 'pending_agency_reassignment' because the
     * assigned agency (default or product-level override) went inactive with no
     * replacement configured yet. `agency_id` is left unchanged during hold — only
     * `status` flips — so the hold/unhold queries can match on it directly. Cleared
     * (null) once the item resumes, whether via unhold (same agency came back) or
     * reassignment (moved to a new agency).
     */
    hold?: { previousStatus: 'pending' | 'assigned'; heldAt: Date } | null;
    /**
     * Snapshot of the product's pickup location at the moment this order was
     * created — not a live reference, so a later edit to the vendor's business
     * addresses doesn't retroactively change history. `address_snapshot` is
     * null when `source === 'agency_storage'` (the agency's own HQ address is
     * resolved live from `agency_id` instead, since it isn't vendor/product
     * specific). See ProductStatusValidationService / order.service.ts.
     */
    pickup_location: {
      source: 'vendor_address' | 'agency_storage';
      vendor_address_id: mongoose.Types.ObjectId | null;
      address_snapshot: {
        label: string;
        address_line1: string;
        address_line2: string | null;
        city: string;
        state: string | null;
      } | null;
    } | null;
  };
}

export interface IOrder extends Document {
  // Order identification
  order_number: string;                 // Human-readable: ORD-2026-000123
  order_type: OrderType;                // 'physical' | 'digital'

  // Checkout group. A single multi-vendor cart splits into one order per vendor;
  // every order from the same checkout shares this cart_id (the source cart's _id),
  // so the customer can view them as one logical order while each vendor sees only
  // their own single-vendor order.
  cart_id: mongoose.Types.ObjectId;

  // Vendor (CRITICAL: Each order belongs to exactly ONE vendor)
  vendor_id: mongoose.Types.ObjectId;   // Top-level vendor ownership

  // Customer
  customer_id: mongoose.Types.ObjectId;

  // Items
  items: IOrderItem[];

  // Pricing
  currency: string;                     // Currency snapshot
  price_breakdown: IPriceBreakdown;     // Detailed price info
  total_amount: number;                 // Convenience field (same as price_breakdown.total)

  // Payment tracking
  payment_status: PaymentStatus;
  payment_intent_id?: string;           // Payment provider reference

  // Fulfillment tracking
  fulfillment_status: FulfillmentStatus;

  // Payment-dispute hold. When a Stripe charge is disputed the order is frozen
  // (no forward fulfilment) until the dispute settles. Set by the dispute webhook.
  dispute_hold?: {
    active: boolean;
    disputed_at?: Date | null;
    resolved_at?: Date | null;
    gateway_dispute_id?: string | null;
    reason?: string | null;
  };

  // Completion (customer confirmation of delivery/satisfaction).
  // Orthogonal to fulfillment_status: it gates the escrow release, NOT the
  // fulfillment state machine. Set by the customer confirm-delivery endpoint or
  // by the auto-confirm sweep.
  completion: {
    confirmed_at: Date | null;
    confirmed_by: 'customer' | 'system' | null;
    auto: boolean;
  };

  // Timestamps
  created_at: Date;
  updated_at: Date;
}

const OrderItemSchema = new Schema({
  // Variant data (first-class)
  variant_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.PRODUCT_VARIANT,
    required: true  // REQUIRED - variant is the sellable unit
  },
  sku: {
    type: String,
    required: true
  },
  variant_title: {
    type: String
  },
  options_snapshot: {
    type: String,
    required: true,
    default: 'default'
  },

  // Product data (context)
  product_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.PRODUCT,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  vendor_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.VENDOR,
    required: true
  },
  product_type: {
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
    required: true
  },

  // Delivery (optional - only for physical orders)
  delivery: {
    type: {
      agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
      shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, default: null },
      status: {
        type: String,
        enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
        default: 'pending'
      },
      free_delivery: { type: Boolean, default: false },
      hold: {
        type: {
          previousStatus: { type: String, enum: ['pending', 'assigned'], required: true },
          heldAt: { type: Date, required: true },
        },
        required: false,
        default: null,
      },
      pickup_location: {
        type: {
          source: { type: String, enum: ['vendor_address', 'agency_storage'], required: true },
          vendor_address_id: { type: Schema.Types.ObjectId, default: null },
          address_snapshot: {
            type: {
              label: { type: String, required: true },
              address_line1: { type: String, required: true },
              address_line2: { type: String, default: null },
              city: { type: String, required: true },
              state: { type: String, default: null },
            },
            required: false,
            default: null,
          },
        },
        required: false,
        default: null,
      },
    },
    required: false  // Only required for physical orders
  }
});

const OrderSchema = new Schema<IOrder>({
  // Order identification
  order_number: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  order_type: {
    type: String,
    enum: ['physical', 'digital'],
    required: true,
    index: true
  },

  // Checkout group (source cart's _id). Shared across all per-vendor orders of one checkout.
  cart_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.CART,
    required: true,
    index: true  // For customer grouped-order queries
  },

  // Vendor (CRITICAL: Each order belongs to exactly ONE vendor)
  vendor_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.VENDOR,
    required: true,
    index: true  // For vendor order queries
  },

  // Customer
  customer_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.CUSTOMER,
    required: true,
    index: true  // For customer order history queries
  },

  // Items
  items: [OrderItemSchema],

  // Pricing
  currency: {
    type: String,
    required: true
  },
  price_breakdown: {
    base: { type: Number, required: true, min: 0 },
    tax: { type: Number, required: true, min: 0, default: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 }
  },
  total_amount: {
    type: Number,
    required: true,
    min: 0
  },

  // Payment tracking
  payment_status: {
    type: String,
    enum: ['pending', 'AWAITING_PAYMENT', 'paid', 'disputed', 'failed', 'refunded'],
    default: 'pending',
    index: true  // For payment status queries
  },
  payment_intent_id: {
    type: String
  },

  // Fulfillment tracking
  fulfillment_status: {
    type: String,
    enum: ['pending', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'delivered', 'fulfilled', 'cancelled', 'returned'],
    default: 'pending',
    index: true  // For fulfillment status queries
  },

  // Payment-dispute hold (set/cleared by the Stripe dispute webhook).
  dispute_hold: {
    active: { type: Boolean, default: false },
    disputed_at: { type: Date, default: null },
    resolved_at: { type: Date, default: null },
    gateway_dispute_id: { type: String, default: null },
    reason: { type: String, default: null }
  },

  // Completion (customer confirmation; gates escrow release).
  completion: {
    confirmed_at: { type: Date, default: null },
    confirmed_by: { type: String, enum: ['customer', 'system', null], default: null },
    auto: { type: Boolean, default: false }
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Validation: Physical orders must have delivery info for all items
OrderSchema.pre('save', function (next) {
  if (this.order_type === 'physical') {
    for (const item of this.items) {
      if (!item.delivery) {
        return next(new Error('Physical order items must have delivery information'));
      }
    }
  }

  // Validation: Digital orders must NOT have delivery info
  if (this.order_type === 'digital') {
    for (const item of this.items) {
      if (item.delivery) {
        return next(new Error('Digital order items must not have delivery information'));
      }
    }
  }

  // Validation: All items must be same type as order
  for (const item of this.items) {
    if (item.product_type !== this.order_type) {
      return next(new Error(`Order type mismatch: order is ${this.order_type} but item is ${item.product_type}`));
    }
  }

  // Validation: Each order belongs to exactly ONE vendor — every item's vendor
  // must equal the order's vendor. Defense in depth for the per-vendor cart split.
  for (const item of this.items) {
    if (item.vendor_id.toString() !== this.vendor_id.toString()) {
      return next(new Error(`Vendor mismatch: order vendor is ${this.vendor_id} but item vendor is ${item.vendor_id}`));
    }
  }

  // Validation: No service products allowed
  for (const item of this.items) {
    if ((item.product_type as string) === 'service') {
      return next(new Error('SERVICE_PRODUCTS_NOT_ALLOWED_IN_ORDERS: Service products cannot be in orders'));
    }
  }

  next();
});

// Additional compound indexes
OrderSchema.index({ customer_id: 1, created_at: -1 });  // Customer order history
OrderSchema.index({ customer_id: 1, cart_id: 1 });      // Customer grouped-order (checkout group) view
OrderSchema.index({ order_type: 1, payment_status: 1 }); // Payment queries
OrderSchema.index({ order_type: 1, fulfillment_status: 1 }); // Fulfillment queries

// Vendor-scoped indexes (critical for vendor dashboard performance)
OrderSchema.index({ vendor_id: 1, created_at: -1 });  // Vendor order history
OrderSchema.index({ vendor_id: 1, fulfillment_status: 1 });  // Vendor fulfillment queries
OrderSchema.index({ vendor_id: 1, payment_status: 1 });  // Vendor payment queries

export const OrderModel = mongoose.model<IOrder>(MODELS.ORDER, OrderSchema, COLLECTIONS.ORDER);
