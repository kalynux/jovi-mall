import mongoose, { Schema, Document } from 'mongoose';

/**
 * Notification Types
 * 
 * Covers all operationally critical vendor events.
 */
export type NotificationType =
    | 'order.created'
    | 'order.cancelled'
    | 'booking.created'
    | 'booking.cancelled'
    | 'payment.received.partial'
    | 'payment.received.full';

/**
 * Aggregate Types
 * 
 * The domain entity that triggered this notification.
 */
export type AggregateType = 'order' | 'booking' | 'payment';

/**
 * Delivery Channels
 * 
 * Historical snapshot of channels used at notification creation time.
 */
export type DeliveryChannel = 'in-app' | 'email' | 'telegram' | 'whatsapp';

/**
 * Vendor Notification Interface
 * 
 * In-app notifications are the primary source of truth.
 * Secondary channels (email, telegram, whatsapp) are fire-and-forget.
 */
export interface IVendorNotification extends Document {
    vendorId: mongoose.Types.ObjectId;
    type: NotificationType;
    title: string;
    message: string;
    aggregateType: AggregateType;
    aggregateId: mongoose.Types.ObjectId;
    deliveredVia: DeliveryChannel[];
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
}

const VendorNotificationSchema = new Schema<IVendorNotification>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: 'Vendor',
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: [
                'order.created',
                'order.cancelled',
                'booking.created',
                'booking.cancelled',
                'payment.received.partial',
                'payment.received.full'
            ],
            required: true
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200
        },
        message: {
            type: String,
            required: true,
            trim: true,
            maxlength: 1000
        },
        aggregateType: {
            type: String,
            enum: ['order', 'booking', 'payment'],
            required: true
        },
        aggregateId: {
            type: Schema.Types.ObjectId,
            required: true
        },
        deliveredVia: {
            type: [String],
            enum: ['in-app', 'email', 'telegram', 'whatsapp'],
            default: ['in-app'],
            required: true
        },
        isRead: {
            type: Boolean,
            default: false,
            required: true
        },
        readAt: {
            type: Date,
            default: null
        },
        idempotencyKey: {
            type: String,
            required: true,
            unique: true,
            index: true
        }
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        collection: 'vendor_notifications'
    }
);

// Indexes for efficient vendor-scoped queries
VendorNotificationSchema.index({ vendorId: 1, createdAt: -1 }); // List notifications
VendorNotificationSchema.index({ vendorId: 1, isRead: 1 }); // Unread queries + bulk read performance

// Ensure in-app is always included
VendorNotificationSchema.pre('save', function (next) {
    if (!this.deliveredVia.includes('in-app')) {
        this.deliveredVia.unshift('in-app');
    }
    next();
});

export const VendorNotificationModel =
    (mongoose.models.VendorNotification as mongoose.Model<IVendorNotification>) ||
    mongoose.model<IVendorNotification>('VendorNotification', VendorNotificationSchema);
