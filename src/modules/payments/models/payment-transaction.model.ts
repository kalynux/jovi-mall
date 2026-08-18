import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * PaymentTransaction - Enterprise-grade payment tracking
 * 
 * DESIGN PRINCIPLES:
 * - Idempotent by design (unique idempotencyKey)
 * - Gateway-agnostic (normalized status)
 * - Audit-compliant (amount snapshots, never rely on Order table)
 * - Replay-attack resistant (gatewayPayloadHash)
 * - Order-centric (all payments tied to an order)
 * 
 * CRITICAL GUARANTEES:
 * - Unique idempotencyKey prevents duplicate payments
 * - Amount snapshots for legal/audit (never trust Order table for money history)
 * - Payload hash detects duplicate webhooks and replay attacks
 * - Status transitions are logged in rawGatewayPayloads
 */

export type PaymentStatus =
  | 'INITIATED'     // Payment created, awaiting gateway response
  | 'PENDING'       // User action required (e.g., USSD dial, card confirmation)
  | 'SUCCEEDED'     // Payment confirmed by gateway (unambiguous success)
  | 'FAILED'        // Payment rejected by gateway
  | 'CANCELLED'     // User cancelled payment
  | 'REFUNDED';     // Payment was refunded

export type PaymentMethod =
  | 'MOBILE'        // Mobile money (NotchPay, MyCoolPay)
  | 'CARD'          // Card payment (Stripe)
  | 'CASH';         // Cash payment (manual)

export type PaymentGatewayType =
  | 'NOTCHPAY'      // Primary mobile money gateway
  | 'MYCOOLPAY'     // Fallback mobile money gateway
  | 'STRIPE';       // Card payment gateway

/**
 * What a payment is FOR, when the source id alone is ambiguous.
 *
 * A booking can be paid twice: once for the quoted price, and again for a balance
 * raised when the service ran over. Both rows carry the same `bookingId`, so
 * without this the webhook cannot tell them apart — and the success handler,
 * which returns early on an already-paid booking, would silently swallow the
 * balance payment and never credit it.
 *
 * `primary` is the default and covers every pre-existing row.
 */
export type PaymentPurpose = 'primary' | 'booking_balance';

export interface IPaymentTransaction extends Document {
  // Source linkage (exactly one of orderId | bookingId | cartId must be set)
  orderId?: Types.ObjectId;         // Source order (single-order product payments)
  bookingId?: Types.ObjectId;       // Source booking (for service payments)
  cartId?: Types.ObjectId;          // Checkout group (multi-vendor cart → N orders, one payment)
  orderIds?: Types.ObjectId[];      // The group's orders (required when cartId is set)
  /** What this payment settles. See PaymentPurpose. */
  purpose: PaymentPurpose;
  /**
   * Who paid — but NOT one kind of id, despite the `ref` below.
   *
   * Order and cart payments write `order.customer_id` (a CUSTOMER id); booking
   * payments write `booking.userId`, which refs USER. So the collection holds
   * both, and which one a row carries depends on how it was created.
   *
   * Anything scoping a transaction to its payer must therefore accept either —
   * see the ownership check on `GET /api/payments/:transactionId`. Worth
   * normalising, but not without a migration: narrowing to one kind first would
   * lock the other's payer out of their own payment record.
   */
  userId: Types.ObjectId;

  // Gateway info
  gateway: PaymentGatewayType;      // Which gateway processed this
  method: PaymentMethod;            // Payment method type
  gatewayRef: string;               // Gateway's payment reference (transaction ID)

  // Status tracking
  status: PaymentStatus;            // Current payment status

  // Amount snapshots (CRITICAL FOR AUDIT)
  // Never rely on Order table for money history - store here for:
  // - Legal audit trails
  // - Dispute resolution
  // - Historical reconstruction
  // - Defense against retroactive order edits
  amountSnapshot: number;           // Amount at payment time
  currencySnapshot: string;         // Currency at payment time

  // Idempotency
  idempotencyKey: string;           // hash(orderId + userId + amount) - prevents duplicate payments

  /**
   * OUR reference, handed to the gateway and echoed back on its callback.
   *
   * Distinct from `idempotencyKey` on purpose. That key is
   * `sha256(orderId:userId:amount)` — deterministic, which is exactly what an
   * initiate-dedup key should be, and exactly what a gateway-facing identifier
   * must not be: all three inputs are knowable. `merchantRef` is 128 random
   * bits and carries a routing prefix so a mobile-money callback for a plan
   * purchase or a credit top-up (neither of which creates a row in THIS
   * collection) can find its way home. See `domain/merchant-reference.ts`.
   *
   * Optional because every row written before this field existed has none;
   * the webhook lookup falls back to `(gateway, gatewayRef)`.
   */
  merchantRef?: string;

  /**
   * Wrong OTP submissions on this transaction.
   *
   * My-CoolPay's Orange Money flow answers `REQUIRE_OTP`, and the endpoint
   * that accepts the code is unauthenticated — it sits beside `initiate` and
   * `verify`, which are open by design for shareable payment links. A
   * six-digit code with unlimited attempts is not a secret, so the counter
   * lives here, on the object being attacked.
   */
  otpAttempts: number;

  // Gateway payload tracking
  rawGatewayPayloads: any[];        // Array of all gateway responses (multi-step flows)
  /**
   * Hash of the last webhook payload.
   *
   * ⚠ **No longer replay protection**, and it never really was: a single slot
   * shared with the initiate and verify paths cannot answer "have I seen this
   * event". Dedup moved to `payment_webhook_events`, keyed on the provider's
   * own event id. This field survives as a debugging aid only — do not gate
   * anything on it.
   */
  gatewayPayloadHash?: string;

  // Refund tracking
  totalRefunded: number;            // Sum of all completed refunds (from RefundTransaction)
  hasPartialRefund: boolean;        // True if 0 < totalRefunded < amountSnapshot

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

const PaymentTransactionSchema = new Schema<IPaymentTransaction>({
  // Order/Booking linkage
  orderId: {
    type: Schema.Types.ObjectId,
    ref: MODELS.ORDER,
    index: true  // Fast lookup by order
  },
  bookingId: {
    type: Schema.Types.ObjectId,
    ref: MODELS.BOOKING,
    index: true  // Fast lookup by booking
  },
  cartId: {
    type: Schema.Types.ObjectId,
    ref: MODELS.CART,
    index: true  // Fast lookup by checkout group
  },
  orderIds: {
    type: [Schema.Types.ObjectId],
    ref: MODELS.ORDER,
    default: undefined  // The group's orders; set only for cart-group payments
  },
  // Defaults to 'primary' so every existing row reads correctly with no migration.
  purpose: {
    type: String,
    enum: ['primary', 'booking_balance'],
    required: true,
    default: 'primary'
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: MODELS.CUSTOMER,
    required: true,
    index: true  // Customer payment history
  },

  // Gateway info
  gateway: {
    type: String,
    enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'],
    required: true,
    index: true  // Analytics by gateway
  },
  method: {
    type: String,
    enum: ['MOBILE', 'CARD', 'CASH'],
    required: true
  },
  gatewayRef: {
    type: String,
    required: true,
    index: true  // Gateway webhook lookups
  },

  // Status tracking
  status: {
    type: String,
    enum: ['INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED'],
    default: 'INITIATED',
    required: true,
    index: true  // Status-based queries
  },

  // Amount snapshots (AUDIT TRAIL)
  amountSnapshot: {
    type: Number,
    required: true,
    min: 0
  },
  currencySnapshot: {
    type: String,
    required: true
  },

  // Idempotency
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,  // CRITICAL: Prevents duplicate payments
    index: true
  },

  // Our gateway-facing reference. `sparse` because legacy rows have none — a
  // plain unique index would refuse the second null and every write would fail.
  merchantRef: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },

  otpAttempts: {
    type: Number,
    default: 0,
    min: 0
  },

  // Gateway payload tracking
  rawGatewayPayloads: {
    type: [],
    default: []
  },
  gatewayPayloadHash: {
    type: String,
    index: true  // Detect duplicate webhook payloads
  },

  // Refund tracking
  totalRefunded: {
    type: Number,
    default: 0,
    min: 0
  },
  hasPartialRefund: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Validation: Exactly one of orderId | bookingId | cartId must be set.
// - orderId : single-order product payment (legacy / booking-style single order)
// - bookingId: service booking payment
// - cartId  : checkout group — one payment settles every order in orderIds
PaymentTransactionSchema.pre('validate', function (next) {
  const sources = [this.orderId, this.bookingId, this.cartId].filter(Boolean);

  if (sources.length === 0) {
    return next(new Error('PaymentTransaction must have one of orderId, bookingId, or cartId'));
  }
  if (sources.length > 1) {
    return next(new Error('PaymentTransaction must have exactly one of orderId, bookingId, or cartId'));
  }
  if (this.cartId && (!this.orderIds || this.orderIds.length === 0)) {
    return next(new Error('PaymentTransaction with cartId must include its orderIds'));
  }
  next();
});

// Composite indexes for common queries
PaymentTransactionSchema.index({ orderId: 1, status: 1 });  // Order payment status
// Multikey. A CART checkout writes ONE payment for N orders and sets `orderIds`, never
// `orderId`, so this is the index that finds a cart-checkout order's payment — the lookup
// the refund path makes on every refund of the majority of orders on the platform.
PaymentTransactionSchema.index({ orderIds: 1, status: 1 }); // Cart-group order payment status
PaymentTransactionSchema.index({ bookingId: 1, status: 1 }); // Booking payment status
PaymentTransactionSchema.index({ userId: 1, createdAt: -1 }); // Customer payment history
PaymentTransactionSchema.index({ gateway: 1, status: 1, createdAt: -1 }); // Gateway analytics

// Virtual field: net amount after refunds
PaymentTransactionSchema.virtual('netAmount').get(function () {
  return this.amountSnapshot - this.totalRefunded;
});

export const PaymentTransactionModel = mongoose.model<IPaymentTransaction>(MODELS.PAYMENT_TRANSACTION, PaymentTransactionSchema, COLLECTIONS.PAYMENT_TRANSACTION);
