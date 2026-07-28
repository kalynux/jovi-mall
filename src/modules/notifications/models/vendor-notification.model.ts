import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

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
    | 'payment.received.full'
    | 'storage.alert'
    | 'connection.request_received'
    | 'connection.approved'
    | 'connection.rejected'
    | 'connection.reapproval_needed'
    | 'payout.requested'
    | 'payout.paid'
    | 'payout.rejected'
    // A delivery agency declined a shipment; the vendor must reassign it.
    | 'shipment.rejected'
    // Subscription plan lifecycle (billing).
    | 'plan.expiring'
    | 'plan.expired';

/**
 * Aggregate Types
 *
 * The domain entity that triggered this notification.
 */
export type AggregateType = 'order' | 'booking' | 'payment' | 'storage' | 'connection' | 'payout' | 'plan';

/**
 * Delivery Channels
 * 
 * Historical snapshot of channels used at notification creation time.
 */
export type DeliveryChannel = 'in-app' | 'email' | 'telegram' | 'whatsapp' | 'push';

/**
 * Notification Action (deep-link)
 *
 * The clickable action for a notification, localized in the vendor's language.
 * Lets the frontend open the relevant page when a notification is clicked —
 * the same action surfaced as a button on the secondary channels.
 *
 * - `label`: localized button text, e.g. "View order"
 * - `path`:  relative deep-link the SPA can route to, e.g. "orders/665f…"
 * - `url`:   absolute deep-link (present only when VENDOR_APP_URL is configured)
 */
export interface NotificationAction {
    label: string;
    path: string;
    url?: string;
}

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
    action?: NotificationAction;
    deliveredVia: DeliveryChannel[];
    deliveryErrors?: Array<{ channel: DeliveryChannel; error: string; failedAt: Date }>;
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
}

const VendorNotificationSchema = new Schema<IVendorNotification>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
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
                'payment.received.full',
                'storage.alert',
                'connection.request_received',
                'connection.approved',
                'connection.rejected',
                'connection.reapproval_needed',
                'payout.requested',
                'payout.paid',
                'payout.rejected',
                'shipment.rejected',
                'plan.expiring',
                'plan.expired'
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
            enum: ['order', 'booking', 'payment', 'storage', 'connection', 'payout', 'plan'],
            required: true
        },
        aggregateId: {
            type: Schema.Types.ObjectId,
            required: true
        },
        action: {
            type: new Schema(
                {
                    label: { type: String, required: true },
                    path: { type: String, required: true },
                    url: { type: String }
                },
                { _id: false }
            ),
            default: undefined
        },
        deliveredVia: {
            type: [String],
            enum: ['in-app', 'email', 'telegram', 'whatsapp', 'push'],
            default: ['in-app'],
            required: true
        },
        deliveryErrors: {
            type: [
                new Schema(
                    {
                        channel: {
                            type: String,
                            enum: ['in-app', 'email', 'telegram', 'whatsapp', 'push'],
                            required: true
                        },
                        error: { type: String, required: true },
                        failedAt: { type: Date, required: true }
                    },
                    { _id: false }
                )
            ],
            default: undefined
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
        timestamps: { createdAt: true, updatedAt: false }
        // Physical collection name is set centrally via COLLECTIONS (3rd model() arg).
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
    mongoose.model<IVendorNotification>(MODELS.VENDOR_NOTIFICATION, VendorNotificationSchema, COLLECTIONS.VENDOR_NOTIFICATION);
