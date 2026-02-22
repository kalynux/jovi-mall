import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { BookingStatus } from '../types/booking.types';

export type BookingPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'paid'
  | 'failed'
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
}

const BookingSchema = new Schema<IBooking>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: 'Vendor',
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
      enum: ['unpaid', 'pending', 'paid', 'failed', 'refunded'],
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
      ref: 'PaymentTransaction',
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
    ...BaseSchemaFields,
  },
  BaseSchemaOptions
);

// Compound indexes for efficient queries
BookingSchema.index({ vendorId: 1, startAt: 1 });
BookingSchema.index({ userId: 1, status: 1 });
BookingSchema.index({ productId: 1, startAt: 1, status: 1 });
BookingSchema.index({ vendorId: 1, paymentStatus: 1 }); // Vendor payment tracking

// Pre-save hook: Auto-mark free bookings as paid
BookingSchema.pre('save', function (next) {
  if (this.isNew && !this.requiresPayment) {
    this.paymentStatus = 'paid';
  }
  next();
});

export const Booking = model<IBooking>('Booking', BookingSchema);
