import mongoose, { Schema, Document, Types } from 'mongoose';

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
  // Order/Booking linkage (exactly one must be set)
  orderId?: Types.ObjectId;         // Source order (for product payments)
  bookingId?: Types.ObjectId;       // Source booking (for service payments)
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
    ref: 'Order',
    index: true  // Fast lookup by order
  },
  bookingId: {
    type: Schema.Types.ObjectId,
    ref: 'Booking',
    index: true  // Fast lookup by booking
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'Customer',
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

// Validation: Exactly one of orderId or bookingId must be set
PaymentTransactionSchema.pre('validate', function (next) {
  const hasOrderId = !!this.orderId;
  const hasBookingId = !!this.bookingId;

  if (!hasOrderId && !hasBookingId) {
    next(new Error('PaymentTransaction must have either orderId or bookingId'));
  } else if (hasOrderId && hasBookingId) {
    next(new Error('PaymentTransaction cannot have both orderId and bookingId'));
  } else {
    next();
  }
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

export const PaymentTransactionModel = mongoose.model<IPaymentTransaction>(
  'PaymentTransaction',
  PaymentTransactionSchema
);
