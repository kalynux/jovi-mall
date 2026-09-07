import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';

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
/**
 * How the order is paid.
 * - 'online': prepaid via a gateway (Stripe / NotchPay / MyCoolPay) — the default.
 * - 'cash_on_delivery': cash handed to the delivery agent per shipment, verified
 *   by a delivery code (see src/modules/cod/). COD orders fulfil BEFORE payment.
 */
export type OrderPaymentMethod = 'online' | 'cash_on_delivery';
/**
 * 'partially_paid' is COD-only: at least one of the order's shipments had its
 * cash collected while others are still outstanding (or ended 'returned').
 */
export type PaymentStatus = 'pending' | 'AWAITING_PAYMENT' | 'partially_paid' | 'paid' | 'disputed' | 'failed' | 'refunded';
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

  // === NEGOTIATED PRICE (bargaining agent — absent on an ordinary line) ===
  /**
   * The haggled price, and the marker that this line was haggled. Equal to
   * `price` above, which stays the one field every existing reader uses.
   *
   * `EarningsSplitService` keys the platform's AI margin on the PAIR of this and
   * `floor_price_snapshot` — a line with neither yields zero uplift and zero
   * margin, which is what makes a mixed order work with no branch at the call
   * site.
   */
  negotiated_unit_price?: number | null;
  /**
   * The vendor's floor as of the verdict that CONSUMED the lock at checkout —
   * not the cart's copy, and not a live read.
   *
   * ⚠ This is the input to invariant 1 (`vendorGross >= floor x qty`). Re-reading
   * `variant.price` at split time would read a number the vendor may have
   * changed since the sale, so the platform's share would be a cut of an uplift
   * that never existed — and the vendor could be paid below the floor they
   * actually agreed to sell at.
   *
   * ⚠ Vendor-facing at most. It must never reach a customer DTO.
   */
  floor_price_snapshot?: number | null;

  // === DELIVERY (Optional - only for physical products) ===
  delivery?: {
    agency_id: mongoose.Types.ObjectId;
    shipment_id?: mongoose.Types.ObjectId | null;
    status: 'pending' | 'assigned' | 'handing_over' | 'picked_up' | 'in_transit' | 'agent_delivered' | 'delivered' | 'failed' | 'returned' | 'rejected' | 'pending_agency_reassignment';
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
     * addresses doesn't retroactively change history.
     *
     * The two sources snapshot different amounts on purpose:
     *
     * - `vendor_address` copies the whole address into `address_snapshot`. It is
     *   the vendor's record of a place they chose per product, and history must
     *   not re-point when they edit their profile.
     * - `agency_storage` snapshots only the CHOICE — `agency_address_id`, which
     *   depot — and leaves `address_snapshot` null. The depot's street line is
     *   the agency's own live record, and an agent must be driven to where that
     *   depot *is*, not where it was at checkout, so an agency correcting an
     *   address fixes every in-flight shipment. A null `agency_address_id` means
     *   the primary depot; see `resolveHqAddress`.
     *
     * See ProductStatusValidationService / order.service.ts.
     */
    pickup_location: {
      source: 'vendor_address' | 'agency_storage';
      vendor_address_id: mongoose.Types.ObjectId | null;
      /** Which agency depot, when `source === 'agency_storage'`. Null = primary. */
      agency_address_id: mongoose.Types.ObjectId | null;
      address_snapshot: {
        label: string;
        address_line1: string;
        address_line2: string | null;
        city: string;
        state: string | null;
        /** Geocoded pickup address snapshotted from the vendor business address. */
        geo: IGeoAddress | null;
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
  payment_method: OrderPaymentMethod;
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

  // Drop-off (customer delivery) address — geocoded and snapshotted at checkout,
  // durable like the per-item pickup snapshot. Physical orders only; null for
  // digital orders and for legacy orders created before this field existed (those
  // readers fall back to the customer's current default saved address).
  delivery_address: IGeoAddress | null;

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

  // Negotiated price — see IOrderItem. Absent (null) on every ordinary line, and
  // on every order placed before the bargaining agent existed; the split reads
  // the pair and computes a zero margin for either.
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

  // Delivery (optional - only for physical orders)
  delivery: {
    type: {
      agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
      shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, default: null },
      status: {
        type: String,
        enum: ['pending', 'assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
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
          // Which agency depot was chosen. Null = the primary. Deliberately an id
          // rather than a snapshot — see the interface comment above.
          agency_address_id: { type: Schema.Types.ObjectId, default: null },
          address_snapshot: {
            type: {
              label: { type: String, required: true },
              address_line1: { type: String, required: true },
              address_line2: { type: String, default: null },
              city: { type: String, required: true },
              state: { type: String, default: null },
              // Geocoded snapshot of the vendor business address at order time.
              geo: { type: GeoAddressSchema, default: null },
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
  payment_method: {
    type: String,
    enum: ['online', 'cash_on_delivery'],
    default: 'online',
    required: true
  },
  payment_status: {
    type: String,
    enum: ['pending', 'AWAITING_PAYMENT', 'partially_paid', 'paid', 'disputed', 'failed', 'refunded'],
    default: 'pending'
    // No single-field index: `{ payment_status: 1, created_at: -1 }` below is a superset.
  },
  payment_intent_id: {
    type: String
  },

  // Fulfillment tracking
  fulfillment_status: {
    type: String,
    enum: ['pending', 'processing', 'partially_shipped', 'shipped', 'partially_delivered', 'delivered', 'fulfilled', 'cancelled', 'returned'],
    default: 'pending'
    // No single-field index: `{ fulfillment_status: 1, created_at: -1 }` below is a superset.
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
  },

  // Drop-off (customer delivery) address, geocoded + snapshotted at checkout.
  // Physical orders only; null otherwise.
  delivery_address: { type: GeoAddressSchema, default: null }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Geospatial index for the drop-off address (proximity/routing queries).
OrderSchema.index({ 'delivery_address.coordinates': '2dsphere' }, { sparse: true });

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

// ── Platform-wide administrative oversight ──────────────────────────────────
// Every index here backs a sort or filter on wi-admin's `/api/v1/orders`, which is the
// first surface to query this collection WITHOUT a vendor or customer scope. Before them
// the default list — newest first, no filter — was a full collection scan plus a blocking
// in-memory sort, and a client could ask for it by query string.
//
// The rule wi-admin's ORDER_SORT map states: a sortable field with no index is a
// collection scan somebody can request. These are what pay for it.
OrderSchema.index({ created_at: -1 });                            // the unfiltered admin list
OrderSchema.index({ payment_status: 1, created_at: -1 });         // filter + default sort
OrderSchema.index({ fulfillment_status: 1, created_at: -1 });     // filter + default sort

// The dispute queue. PARTIAL, so it holds only the handful of frozen orders rather than a
// key per order in the collection, and it matches the queue's own filter exactly.
OrderSchema.index(
  { 'dispute_hold.disputed_at': -1 },
  { partialFilterExpression: { 'dispute_hold.active': true }, name: 'dispute_queue' }
);

// NOTE: the two compounds above make the standalone `payment_status` and
// `fulfillment_status` single-field indexes redundant — they are prefixes of the new keys.
// `index: true` has been removed from both field definitions, but Mongoose's `autoIndex`
// CREATES indexes and never DROPS them, so the old ones survive on any database that has
// already run. `npm run migrate:admin-order-indexes` removes them; it is safe to re-run
// and safe to skip (a redundant index costs write throughput, not correctness).

export const OrderModel = mongoose.model<IOrder>(MODELS.ORDER, OrderSchema, COLLECTIONS.ORDER);
