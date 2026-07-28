import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Agency Notification
 *
 * Multi-channel counterpart to vendor-notification.model.ts — in-app, push,
 * and (per preference) one secondary channel of email/telegram/whatsapp, all
 * catalog/i18n-driven. See agency-notification-catalog.ts and
 * agency-notification-preference.model.ts.
 */
export type AgencyNotificationType =
    | 'connection.request_received'
    | 'connection.approved'
    | 'connection.rejected'
    | 'connection.reapproval_needed'
    | 'shipment.assigned'
    /** An agent accepted the shipment offer — it's now theirs. */
    | 'shipment.offer.accepted'
    /** No agent accepted (declined / timed out / pool exhausted) — assign manually. */
    | 'shipment.assignment.unfilled'
    | 'payout.requested'
    | 'payout.paid'
    | 'payout.rejected'
    /** An agent declared a cash hand-over this agency must confirm or reject. */
    | 'cod.deposit.declared'
    /** An agent paid the platform directly; this agency's liability fell with it. */
    | 'cod.deposit.direct_to_platform'
    /** Subscription plan lifecycle (billing). */
    | 'plan.expiring'
    | 'plan.expired'
    /** This agency crossed its plan's (soft) unterminated-shipment cap. */
    | 'shipment.cap.exceeded'
    /** This agency's media storage crossed a usage threshold (80/90/100%). */
    | 'storage.alert';
export type AgencyAggregateType = 'connection' | 'shipment' | 'payout' | 'deposit' | 'plan' | 'storage';

/**
 * Deep-link action for a notification, localized in the agency's language.
 * Mirrors vendor-notification.model.ts's NotificationAction.
 */
export interface AgencyNotificationAction {
    label: string;
    path: string;
    url?: string;
}

export type AgencyDeliveryChannel = 'in-app' | 'email' | 'telegram' | 'whatsapp' | 'push';

export interface IAgencyNotification extends Document {
    agencyId: mongoose.Types.ObjectId;
    type: AgencyNotificationType;
    title: string;
    message: string;
    aggregateType: AgencyAggregateType;
    aggregateId: mongoose.Types.ObjectId;
    action?: AgencyNotificationAction;
    deliveredVia: AgencyDeliveryChannel[];
    deliveryErrors?: Array<{ channel: AgencyDeliveryChannel; error: string; failedAt: Date }>;
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
}

const AgencyNotificationSchema = new Schema<IAgencyNotification>(
    {
        agencyId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.DELIVERY_AGENCY,
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: [
                'connection.request_received',
                'connection.approved',
                'connection.rejected',
                'connection.reapproval_needed',
                'shipment.assigned',
                'shipment.offer.accepted',
                'shipment.assignment.unfilled',
                'payout.requested',
                'payout.paid',
                'payout.rejected',
                'cod.deposit.declared',
                'cod.deposit.direct_to_platform',
                'plan.expiring',
                'plan.expired',
                'shipment.cap.exceeded',
                'storage.alert'
            ],
            required: true
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        aggregateType: { type: String, enum: ['connection', 'shipment', 'payout', 'deposit', 'plan', 'storage'], required: true },
        aggregateId: { type: Schema.Types.ObjectId, required: true },
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
        isRead: { type: Boolean, default: false, required: true },
        readAt: { type: Date, default: null },
        idempotencyKey: { type: String, required: true, unique: true, index: true }
    },
    {
        timestamps: { createdAt: true, updatedAt: false }
    }
);

// Ensure in-app is always included
AgencyNotificationSchema.pre('save', function (next) {
    if (!this.deliveredVia.includes('in-app')) {
        this.deliveredVia.unshift('in-app');
    }
    next();
});

AgencyNotificationSchema.index({ agencyId: 1, createdAt: -1 });
AgencyNotificationSchema.index({ agencyId: 1, isRead: 1 });

export const AgencyNotificationModel =
    (mongoose.models.AgencyNotification as mongoose.Model<IAgencyNotification>) ||
    mongoose.model<IAgencyNotification>(MODELS.AGENCY_NOTIFICATION, AgencyNotificationSchema, COLLECTIONS.AGENCY_NOTIFICATION);
