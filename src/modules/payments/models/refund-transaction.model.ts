import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * RefundTransaction - Track partial and full refunds
 * 
 * CRITICAL: Refunds are grouped by completedAt date for analytics, NOT original order date.
 * This enables accurate day-by-day refund metrics without retroactive GMV adjustments.
 */

export interface IRefundTransaction extends Document {
    paymentTransactionId: mongoose.Types.ObjectId; // Original payment reference
    orderId?: mongoose.Types.ObjectId;              // Source order (if order payment)
    bookingId?: mongoose.Types.ObjectId;            // Source booking  (if booking payment)
    vendorId: mongoose.Types.ObjectId;              // Vendor affected by refund
    userId: mongoose.Types.ObjectId;                // Customer receiving refund

    refundAmount: number;                           // Amount refunded (can be partial)
    currency: string;                               // Currency snapshot (e.g., 'XAF')

    reason?: string;                                // Refund reason (optional)
    status: 'pending' | 'completed' | 'failed';

    gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE';   // Payment gateway
    gatewayRefundRef?: string;                      // Gateway's refund reference

    initiatedBy: mongoose.Types.ObjectId;           // User/Admin who initiated refund
    initiatedByRole: 'vendor' | 'admin' | 'customer';

    createdAt: Date;
    completedAt?: Date;                             // CRITICAL for analytics grouping
}

const RefundTransactionSchema = new Schema<IRefundTransaction>(
    {
        paymentTransactionId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.PAYMENT_TRANSACTION,
            required: true
        },
        orderId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.ORDER
        },
        bookingId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.BOOKING
        },
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
            required: true,
            index: true // For vendor-scoped analytics queries
        },
        userId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.USER,
            required: true
        },
        refundAmount: {
            type: Number,
            required: true,
            min: 0
        },
        currency: {
            type: String,
            required: true
        },
        reason: {
            type: String
        },
        status: {
            type: String,
            enum: ['pending', 'completed', 'failed'],
            required: true,
            default: 'pending'
        },
        gateway: {
            type: String,
            enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'],
            required: true
        },
        gatewayRefundRef: {
            type: String
        },
        initiatedBy: {
            type: Schema.Types.ObjectId,
            required: true
        },
        initiatedByRole: {
            type: String,
            enum: ['vendor', 'admin', 'customer'],
            required: true
        },
        completedAt: {
            type: Date
        }
    },
    {
        timestamps: { createdAt: 'createdAt', updatedAt: false } // Only track creation, completedAt is explicit
    }
);

/**
 * Indexes for efficient queries
 */
// Link to original payment
RefundTransactionSchema.index({ paymentTransactionId: 1 });

// Vendor refund history for analytics (by completedAt date)
RefundTransactionSchema.index({ vendorId: 1, completedAt: -1 });

// Vendor refund queries by status and date
RefundTransactionSchema.index({ vendorId: 1, status: 1, completedAt: -1 });

// Order/Booking refund lookup
RefundTransactionSchema.index({ orderId: 1 });
RefundTransactionSchema.index({ bookingId: 1 });

/**
 * Business rule validation: Sum of refunds cannot exceed original payment
 * This should be enforced in the service layer before creating refund
 */

export const RefundTransactionModel = mongoose.model<IRefundTransaction>(MODELS.REFUND_TRANSACTION, RefundTransactionSchema, COLLECTIONS.REFUND_TRANSACTION);
