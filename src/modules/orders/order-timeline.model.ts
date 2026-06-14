import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

/**
 * OrderTimeline Model
 * 
 * Immutable append-only audit trail for order events.
 * 
 * BUSINESS RULES:
 * - Timeline entries are NEVER updated or deleted
 * - Provides complete audit trail for disputes and investigations
 * - Created automatically on order lifecycle events
 * - Visible to vendors (filtered by order ownership)
 * 
 * ACTOR TYPES:
 * - vendor: Vendor user action (status updates, notes)
 * - customer: Customer action (order placement, cancellation)
 * - system: Automated system events (payment processing)
 * - admin: Admin intervention
 */

export type TimelineEventType =
    | 'order.created'
    | 'payment.updated'
    | 'fulfillment.updated'
    | 'delivery.agency_updated'      // NEW: Phase 1 - Delivery agency assignment
    | 'note.added'
    | 'entitlement.revoked'          // NEW: Phase 2 - Digital entitlement revoked
    | 'entitlement.restored'         // NEW: Phase 2 - Digital entitlement restored
    | 'system.action';

export type TimelineActorType = 'vendor' | 'customer' | 'system' | 'admin';

// Plain data interface (for lean queries)
export interface IOrderTimelineData {
    _id: mongoose.Types.ObjectId;
    order_id: mongoose.Types.ObjectId;       // Associated order
    event_type: TimelineEventType;           // Type of event
    description: string;                     // Human-readable description
    metadata: Record<string, any>;           // Event-specific data
    actor_type: TimelineActorType;           // Who triggered this event
    actor_id: mongoose.Types.ObjectId | null; // User ID if applicable
    created_at: Date;                        // When event occurred
    __v?: number;                            // Version key (optional)
}

// Document interface (for full Mongoose documents)
export interface IOrderTimeline extends Document {
    order_id: mongoose.Types.ObjectId;       // Associated order
    event_type: TimelineEventType;           // Type of event
    description: string;                     // Human-readable description
    metadata: Record<string, any>;           // Event-specific data
    actor_type: TimelineActorType;           // Who triggered this event
    actor_id: mongoose.Types.ObjectId | null; // User ID if applicable
    created_at: Date;                        // When event occurred
}

const OrderTimelineSchema = new Schema<IOrderTimeline>({
    order_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.ORDER,
        required: true,
        index: true  // Critical for order timeline queries
    },
    event_type: {
        type: String,
        enum: [
            'order.created',
            'payment.updated',
            'fulfillment.updated',
            'delivery.agency_updated',
            'note.added',
            'entitlement.revoked',
            'entitlement.restored',
            'system.action'
        ],
        required: true
    },
    description: {
        type: String,
        required: true
    },
    metadata: {
        type: Schema.Types.Mixed,
        default: {}
    },
    actor_type: {
        type: String,
        enum: ['vendor', 'customer', 'system', 'admin'],
        required: true
    },
    actor_id: {
        type: Schema.Types.ObjectId,
        default: null
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: false }  // No updates allowed
});

// Compound index for chronological timeline retrieval
OrderTimelineSchema.index({ order_id: 1, created_at: -1 });

// IMMUTABILITY ENFORCEMENT: Prevent updates and deletes
OrderTimelineSchema.pre('updateOne', function (next) {
    next(new Error('Timeline entries cannot be updated'));
});

OrderTimelineSchema.pre('updateMany', function (next) {
    next(new Error('Timeline entries cannot be updated'));
});

OrderTimelineSchema.pre('findOneAndUpdate', function (next) {
    next(new Error('Timeline entries cannot be updated'));
});

OrderTimelineSchema.pre('deleteOne', function (next) {
    next(new Error('Timeline entries cannot be deleted'));
});

OrderTimelineSchema.pre('deleteMany', function (next) {
    next(new Error('Timeline entries cannot be deleted'));
});

export const OrderTimelineModel = mongoose.model<IOrderTimeline>(MODELS.ORDER_TIMELINE, OrderTimelineSchema, COLLECTIONS.ORDER_TIMELINE);
