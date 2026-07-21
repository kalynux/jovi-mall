import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Agency Notification Preferences
 *
 * Mirrors vendor-notification-preference.model.ts. Same rules:
 * - in-app is always enabled (non-configurable)
 * - Only ONE secondary channel can be enabled at a time
 * - Secondary channels require verification before enabling
 * - When enabling a new secondary channel, others are auto-disabled
 */
export interface IAgencyNotificationPreference extends Document {
    agencyId: mongoose.Types.ObjectId;

    // Channel enablement (only one secondary channel allowed)
    inAppEnabled: boolean; // Always true, non-configurable
    emailEnabled: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;

    // Verification status (checked from agency model and link services)
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;

    // Event type preferences
    preferences: {
        /** Covers all four connection.* situations (request received, approved, rejected, reapproval needed). */
        connectionUpdated: boolean;
        /** A vendor's order was dispatched to this agency (shipment.assigned). */
        shipmentAssigned: boolean;
        /** Covers all three payout.* situations (requested, paid, rejected). */
        payoutUpdates: boolean;
        /**
         * Covers cod.deposit.declared and cod.deposit.direct_to_platform.
         *
         * Turning this off has a consequence worth surfacing in the UI: an
         * unanswered declaration opens a `deposit_not_confirmed` flag after
         * DEPOSIT_CONFIRM_DEADLINE_DAYS, which freezes this agency's
         * rolling-reserve releases. The deadline runs whether or not they asked
         * to hear about it.
         */
        codDepositUpdates: boolean;
    };

    updatedAt: Date;
}

const AgencyNotificationPreferenceSchema = new Schema<IAgencyNotificationPreference>(
    {
        agencyId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.DELIVERY_AGENCY,
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
            connectionUpdated: {
                type: Boolean,
                default: true
            },
            shipmentAssigned: {
                type: Boolean,
                default: true
            },
            payoutUpdates: {
                type: Boolean,
                default: true
            },
            codDepositUpdates: {
                type: Boolean,
                default: true
            }
        }
    },
    {
        timestamps: { createdAt: false, updatedAt: true }
    }
);

// Ensure in-app is always enabled
AgencyNotificationPreferenceSchema.pre('save', function (next) {
    if (this.inAppEnabled === false) {
        this.inAppEnabled = true;
    }
    next();
});

export const AgencyNotificationPreferenceModel =
    (mongoose.models.AgencyNotificationPreference as mongoose.Model<IAgencyNotificationPreference>) ||
    mongoose.model<IAgencyNotificationPreference>(
        MODELS.AGENCY_NOTIFICATION_PREFERENCE,
        AgencyNotificationPreferenceSchema,
        COLLECTIONS.AGENCY_NOTIFICATION_PREFERENCE
    );
