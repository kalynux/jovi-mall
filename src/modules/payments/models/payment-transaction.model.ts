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

export interface IPaymentTransaction extends Document {
  // Source linkage (exactly one of orderId | bookingId | cartId must be set)
  orderId?: Types.ObjectId;         // Source order (single-order product payments)
  bookingId?: Types.ObjectId;       // Source booking (for service payments)
  cartId?: Types.ObjectId;          // Checkout group (multi-vendor cart → N orders, one payment)
  orderIds?: Types.ObjectId[];      // The group's orders (required when cartId is set)
  userId: Types.ObjectId;           // Customer making payment

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

  // Gateway payload tracking
  rawGatewayPayloads: any[];        // Array of all gateway responses (multi-step flows)
  gatewayPayloadHash?: string;      // Hash of last webhook payload (detect duplicates/replay attacks)

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
PaymentTransactionSchema.index({ bookingId: 1, status: 1 }); // Booking payment status
PaymentTransactionSchema.index({ userId: 1, createdAt: -1 }); // Customer payment history
PaymentTransactionSchema.index({ gateway: 1, status: 1, createdAt: -1 }); // Gateway analytics

// Virtual field: net amount after refunds
PaymentTransactionSchema.virtual('netAmount').get(function () {
  return this.amountSnapshot - this.totalRefunded;
});

export const PaymentTransactionModel = mongoose.model<IPaymentTransaction>(MODELS.PAYMENT_TRANSACTION, PaymentTransactionSchema, COLLECTIONS.PAYMENT_TRANSACTION);
