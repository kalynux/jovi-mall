import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Vendor Notification Preferences
 * 
 * Controls which events trigger notifications and which channels are used.
 * 
 * Rules:
 * - in-app is always enabled (non-configurable)
 * - Only ONE secondary channel can be enabled at a time
 * - Secondary channels require verification before enabling
 * - When enabling a new secondary channel, others are auto-disabled
 */
export interface IVendorNotificationPreference extends Document {
    vendorId: mongoose.Types.ObjectId;

    // Channel enablement (only one secondary channel allowed)
    inAppEnabled: boolean; // Always true, non-configurable
    emailEnabled: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;

    // Verification status (checked from vendor model and link services)
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;

    // Event type preferences
    preferences: {
        orderCreated: boolean;
        orderCancelled: boolean;
        bookingCreated: boolean;
        bookingCancelled: boolean;
        paymentReceivedPartial: boolean;
        paymentReceivedFull: boolean;
    };

    updatedAt: Date;
}

const VendorNotificationPreferenceSchema = new Schema<IVendorNotificationPreference>(
    {
        vendorId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.VENDOR,
            required: true,
            unique: true,
            index: true
        },
        inAppEnabled: {
            type: Boolean,
            default: true,
            required: true
        },
        emailEnabled: {
            type: Boolean,
            default: false
        },
        telegramEnabled: {
            type: Boolean,
            default: false
        },
        whatsappEnabled: {
            type: Boolean,
            default: false
        },
        emailVerified: {
            type: Boolean,
            default: false
        },
        telegramVerified: {
            type: Boolean,
            default: false
        },
        whatsappVerified: {
            type: Boolean,
            default: false
        },
        preferences: {
            orderCreated: {
                type: Boolean,
                default: true
            },
            orderCancelled: {
                type: Boolean,
                default: true
            },
            bookingCreated: {
                type: Boolean,
                default: true
            },
            bookingCancelled: {
                type: Boolean,
                default: true
            },
            paymentReceivedPartial: {
                type: Boolean,
                default: true
            },
            paymentReceivedFull: {
                type: Boolean,
                default: true
            }
        }
    },
    {
        timestamps: { createdAt: false, updatedAt: true }
        // Physical collection name is set centrally via COLLECTIONS (3rd model() arg).
    }
);

// Ensure in-app is always enabled
VendorNotificationPreferenceSchema.pre('save', function (next) {
    if (this.inAppEnabled === false) {
        this.inAppEnabled = true;
    }
    next();
});

export const VendorNotificationPreferenceModel =
    (mongoose.models.VendorNotificationPreference as mongoose.Model<IVendorNotificationPreference>) ||
    mongoose.model<IVendorNotificationPreference>(MODELS.VENDOR_NOTIFICATION_PREFERENCE, VendorNotificationPreferenceSchema, COLLECTIONS.VENDOR_NOTIFICATION_PREFERENCE);
