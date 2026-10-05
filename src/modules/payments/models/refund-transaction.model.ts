import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PAYMENT_GATEWAY_NAMES, PaymentGatewayName } from '../gateways/gateway.interface';

/**
 * RefundTransaction - the LEDGER of money returned (one row per payment leg of a refund).
 * 
 * CRITICAL: Refunds are grouped by completedAt date for analytics, NOT original order date.
 * This enables accurate day-by-day refund metrics without retroactive GMV adjustments.
 *
 * ── REFUND-FLOW-PLAN § 11.5 (2026-10-05) ─────────────────────────────────────
 * - `refundAmount` is the GROSS, always — what the order lost, and what analytics deduct. The
 *   customer may have received less (`netAmount`, after the refund fee `feeAmount`, R-3).
 * - `paymentTransactionId` and `gateway` are OPTIONAL now: a COD refund and a refund paid
 *   outside the platform (`channel: 'external'` with no payment behind it) have neither. Every
 *   reader must tolerate their absence — `vendor-analytics.service.ts`,
 *   `aggregation-scheduler.ts`, and wi-admin `money` / `statements`.
 * - `refundRequestId` names the `refund_requests` row that produced it. Absent on rows written
 *   by the legacy synchronous path (`PaymentOrchestratorService.refundPayment`).
 * - `channel`: `card_refund` | `payout` | `external`. Absent on legacy rows (read: card_refund).
 */

export type RefundTransactionChannel = 'card_refund' | 'payout' | 'external';

export interface IRefundTransaction extends Document {
    paymentTransactionId?: mongoose.Types.ObjectId | null; // Original payment (absent: COD / external)
    orderId?: mongoose.Types.ObjectId;              // Source order (if order payment)
    bookingId?: mongoose.Types.ObjectId;            // Source booking  (if booking payment)
    vendorId: mongoose.Types.ObjectId;              // Vendor affected by refund
    userId: mongoose.Types.ObjectId;                // Customer receiving refund

    refundAmount: number;                           // GROSS refunded (can be partial)
    currency: string;                               // Currency snapshot (e.g., 'XAF')

    reason?: string;                                // Refund reason (optional)
    status: 'pending' | 'completed' | 'failed';

    gateway?: PaymentGatewayName | null;            // Payment gateway (absent: COD / external)
    gatewayRefundRef?: string;                      // Gateway's refund (or transfer) reference

    /** REFUND-FLOW-PLAN § 11.5. Absent on legacy rows. */
    refundRequestId?: mongoose.Types.ObjectId | null;
    channel?: RefundTransactionChannel | null;
    feeAmount?: number;
    netAmount?: number;

    initiatedBy: mongoose.Types.ObjectId;           // User/Admin who initiated refund
    initiatedByRole: 'vendor' | 'admin' | 'support' | 'customer' | 'system';

    createdAt: Date;
    completedAt?: Date;                             // CRITICAL for analytics grouping
}

const RefundTransactionSchema = new Schema<IRefundTransaction>(
    {
        paymentTransactionId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.PAYMENT_TRANSACTION,
            default: null
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
            enum: [...PAYMENT_GATEWAY_NAMES],
            default: null
        },
        gatewayRefundRef: {
            type: String
        },
        refundRequestId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.REFUND_REQUEST,
            default: null
        },
        channel: {
            type: String,
            enum: ['card_refund', 'payout', 'external', null],
            default: null
        },
        feeAmount: {
            type: Number,
            min: 0
        },
        netAmount: {
            type: Number,
            min: 0
        },
        initiatedBy: {
            type: Schema.Types.ObjectId,
            required: true
        },
        initiatedByRole: {
            type: String,
            enum: ['vendor', 'admin', 'support', 'customer', 'system'],
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

// The refund request a row was written for (REFUND-FLOW-PLAN § 11.5)
RefundTransactionSchema.index({ refundRequestId: 1 }, { sparse: true });

/**
 * Business rule validation: Sum of refunds cannot exceed original payment
 * This should be enforced in the service layer before creating refund
 */

export const RefundTransactionModel = mongoose.model<IRefundTransaction>(MODELS.REFUND_TRANSACTION, RefundTransactionSchema, COLLECTIONS.REFUND_TRANSACTION);
