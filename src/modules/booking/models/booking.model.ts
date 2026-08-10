import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { BookingStatus } from '../types/booking.types';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export type BookingPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'paid'
  | 'disputed'
  | 'failed'
  /**
   * Money is owed back but the gateway could not return it automatically —
   * cash bookings, and the mobile-money gateways whose `refundPayment` is still a
   * placeholder. A support ticket carries it to manual payout. Distinct from
   * `refunded`, which means the customer actually has their money.
   */
  | 'refund_pending'
  | 'refunded';

export type BookingPaymentMethod = 'cash' | 'online';

export interface IBooking extends IBaseDocument {
  productId: Types.ObjectId;
  userId: Types.ObjectId;
  vendorId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  status: BookingStatus;
  externalCalendarEventId?: string; // From calendar provider
  metadata?: Record<string, any>;
  cancelledAt?: Date;
  cancelledReason?: string;

  // Payment tracking
  paymentStatus: BookingPaymentStatus;
  paymentMethod?: BookingPaymentMethod;
  paymentTransactionId?: Types.ObjectId;
  paidAt?: Date; // Set when cash payment is manually confirmed by vendor
  priceSnapshot: number;
  currency: string;
  requiresPayment: boolean;

  /**
   * Completion settlement — what the service actually cost once it was done.
   *
   * `priceSnapshot` stays the ORIGINAL quote forever; these describe the
   * difference. Kept as first-class fields rather than inside `metadata` because
   * money the platform intends to collect has to be queryable (an outstanding
   * balance is a report, and `metadata` is `Mixed` with no index).
   */
  settlement?: {
    /** The settled price. May be above or below `priceSnapshot`. */
    finalPrice: number;
    /** How the vendor settled it. */
    pricingMode: 'fixed' | 'duration';
    settledAt: Date;
    /**
     * `max(0, finalPrice − amountPaid)` at settlement time — what the customer
     * still owes. Never charged automatically; the customer pays it or the
     * vendor records it as cash.
     */
    balanceDue: number;
    /** How much of `balanceDue` has since been collected. */
    balancePaid: number;
    balancePaidAt?: Date;
    balancePaymentMethod?: BookingPaymentMethod;
    /** Payment transaction for an ONLINE balance payment (distinct from the original). */
    balanceTransactionId?: Types.ObjectId;
    /**
     * `max(0, amountPaid − finalPrice)` — the customer overpaid.
     *
     * RECORDED, NOT REFUNDED, by explicit product decision: a vendor settling
     * below the quote is usually a goodwill discount they intend to hand back
     * themselves. Surfaced so it is visible rather than silently kept, and so a
     * later policy change has the number already.
     */
    creditDue: number;
  };
}

const BookingSchema = new Schema<IBooking>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.PRODUCT,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.USER,
      required: true,
      index: true,
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.VENDOR,
      required: true,
      index: true,
    },
    startAt: {
      type: Date,
      required: true,
      index: true,
    },
    endAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: [...Object.values(BookingStatus)],
      required: true,
      default: BookingStatus.PENDING,
      index: true,
    },
    externalCalendarEventId: {
      type: String,
      sparse: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    cancelledAt: {
      type: Date,
    },
    cancelledReason: {
      type: String,
    },

    // Payment tracking
    paymentStatus: {
      type: String,
      // Must stay in lockstep with the BookingPaymentStatus union above — a value
      // present in one and not the other fails validation silently on write.
      enum: ['unpaid', 'pending', 'paid', 'disputed', 'failed', 'refund_pending', 'refunded'],
      required: true,
      default: 'unpaid',
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'online'],
    },
    paymentTransactionId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.PAYMENT_TRANSACTION,
      index: true,
    },
    paidAt: {
      type: Date,
    },
    priceSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'XAF',
    },
    requiresPayment: {
      type: Boolean,
      required: true,
      default: true,
    },
    settlement: {
      type: new Schema(
        {
          finalPrice: { type: Number, required: true, min: 0 },
          pricingMode: { type: String, enum: ['fixed', 'duration'], required: true },
          settledAt: { type: Date, required: true },
          balanceDue: { type: Number, required: true, min: 0, default: 0 },
          balancePaid: { type: Number, required: true, min: 0, default: 0 },
          balancePaidAt: { type: Date },
          balancePaymentMethod: { type: String, enum: ['cash', 'online'] },
          balanceTransactionId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.PAYMENT_TRANSACTION,
          },
          creditDue: { type: Number, required: true, min: 0, default: 0 },
        },
        { _id: false }
      ),
      default: undefined,
    },
    ...BaseSchemaFields,
  },
  BaseSchemaOptions
);

// Compound indexes for efficient queries
BookingSchema.index({ vendorId: 1, startAt: 1 });
BookingSchema.index({ userId: 1, status: 1 });
BookingSchema.index({ productId: 1, startAt: 1, status: 1 });
BookingSchema.index({ vendorId: 1, paymentStatus: 1 }); // Vendor payment tracking
// Outstanding balances — the "who still owes me" report, and the reason
// `settlement` is a real field rather than a bag inside `metadata`.
BookingSchema.index(
  { vendorId: 1, 'settlement.balanceDue': 1 },
  { partialFilterExpression: { 'settlement.balanceDue': { $gt: 0 } } }
);
// The reminder sweep: upcoming confirmed bookings in a time window.
BookingSchema.index({ status: 1, startAt: 1 });

// Pre-save hook: Auto-mark free bookings as paid
BookingSchema.pre('save', function (next) {
  if (this.isNew && !this.requiresPayment) {
    this.paymentStatus = 'paid';
  }
  next();
});

export const Booking = model<IBooking>(MODELS.BOOKING, BookingSchema, COLLECTIONS.BOOKING);
