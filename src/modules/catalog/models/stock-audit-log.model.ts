import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export type StockOperation = 'manual' | 'bulk' | 'reservation' | 'release' | 'order' | 'adjustment';
export type ActorType = 'vendor' | 'system' | 'admin';

export interface StockAuditMetadata {
    orderId?: Types.ObjectId;
    reservationId?: string;
    batchId?: string;
    reason?: string;
}

export interface IStockAuditLog extends IBaseDocument {
    variantId: Types.ObjectId;
    productId: Types.ObjectId;
    vendorId: Types.ObjectId;

    previousQuantity: number;
    newQuantity: number;
    delta: number;

    operation: StockOperation;
    actorType: ActorType;
    actorId?: Types.ObjectId; // vendor/admin ID if not system

    metadata?: StockAuditMetadata;

    timestamp: Date;
}

const StockAuditLogSchema = new Schema<IStockAuditLog>({
    variantId: {
        type: Schema.Types.ObjectId,
        ref: MODELS.PRODUCT_VARIANT,
        required: true,
        index: true
    },
    productId: {
        type: Schema.Types.ObjectId,
        ref: MODELS.PRODUCT,
        required: true,
        index: true
    },
    vendorId: {
        type: Schema.Types.ObjectId,
        ref: MODELS.VENDOR,
        required: true,
        index: true
    },

    previousQuantity: {
        type: Number,
        required: true
    },
    newQuantity: {
        type: Number,
        required: true
    },
    delta: {
        type: Number,
        required: true
    },

    operation: {
        type: String,
        enum: ['manual', 'bulk', 'reservation', 'release', 'order', 'adjustment'],
        required: true,
        index: true
    },
    actorType: {
        type: String,
        enum: ['vendor', 'system', 'admin'],
        required: true
    },
    actorId: {
        type: Schema.Types.ObjectId
    },

    metadata: {
        orderId: { type: Schema.Types.ObjectId, ref: MODELS.ORDER },
        reservationId: { type: String },
        batchId: { type: String, index: true }, // For bulk operations
        reason: { type: String }
    },

    timestamp: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },

    ...BaseSchemaFields
}, BaseSchemaOptions);

// Composite indexes for efficient queries
StockAuditLogSchema.index({ variantId: 1, timestamp: -1 });
StockAuditLogSchema.index({ vendorId: 1, timestamp: -1 });
StockAuditLogSchema.index({ vendorId: 1, operation: 1, timestamp: -1 });

// Prevent updates/deletes (append-only)
StockAuditLogSchema.pre('findOneAndUpdate', function (next) {
    next(new Error('Stock audit logs are append-only and cannot be updated'));
});

StockAuditLogSchema.pre('findOneAndDelete', function (next) {
    next(new Error('Stock audit logs are append-only and cannot be deleted'));
});

export const StockAuditLogModel = model<IStockAuditLog>(MODELS.STOCK_AUDIT_LOG, StockAuditLogSchema, COLLECTIONS.STOCK_AUDIT_LOG);
