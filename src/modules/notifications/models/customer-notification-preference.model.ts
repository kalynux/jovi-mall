import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Customer Notification Preferences
 *
 * Mirrors agent-notification-preference.model.ts. Same rules:
 * - in-app is always enabled (non-configurable)
 * - Only ONE secondary channel can be enabled at a time
 * - Secondary channels require verification before enabling
 * - Enabling a new secondary channel auto-disables the others
 *
 * ── What a customer may and may not switch off ──────────────────────────────
 *
 * The three sibling stacks let the recipient mute anything. This one does not,
 * and the split is deliberate: a vendor muting their own dashboard alerts is
 * their business, but a customer is the *counterparty* to someone else's
 * actions. Two groups are therefore not represented here at all and always send:
 *
 *   - **Money.** Payment received, refund issued, refund pending, balance due.
 *     A silent refund is indistinguishable from a stolen payment, and a balance
 *     nobody was told about cannot fairly be chased.
 *   - **Cancellations.** A vendor calling off an appointment or an order is the
 *     one message a customer cannot be left to discover for themselves.
 *
 * Everything below is progress reporting, which is genuinely optional.
 */
export interface ICustomerNotificationPreference extends Document {
    customerId: mongoose.Types.ObjectId;

    // Channel enablement (only one secondary channel allowed)
    inAppEnabled: boolean; // Always true, non-configurable
    emailEnabled: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;

    // Verification status (computed live from the customer + telegram link)
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;

    preferences: {
        /**
         * Booking created / confirmed / rescheduled / completed. Defaults ON:
         * `booking.confirmed` is how a customer learns a `manual` booking was
         * accepted, and there is no other signal.
         */
        bookingUpdates: boolean;
        /**
         * The pre-appointment reminder. Defaults ON — this is the message that
         * stops a `no-show` being recorded against someone who simply forgot.
         * Kept switchable because a reminder is genuinely a preference; the
         * cancellation that would strand them is not, and is not gated here.
         */
        bookingReminders: boolean;
        /**
         * Order created, shipped, out for delivery, delivered, delivery failed.
         * Defaults ON: "out for delivery" is the only prompt to actually be
         * somewhere, and a failed attempt needs answering.
         */
        orderUpdates: boolean;
        /**
         * Marketing/promotional sends. Defaults **OFF** — opt-in, unlike every
         * other group here, and mirrors `customer.preferences.marketing_opt_in`.
         * Nothing dispatches on it yet; it exists so a future campaign cannot be
         * bolted onto `orderUpdates`, which customers did not consent to ads on.
         */
        marketing: boolean;
    };

    updatedAt: Date;
}

const CustomerNotificationPreferenceSchema = new Schema<ICustomerNotificationPreference>(
    {
        customerId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.CUSTOMER,
            required: true,
            unique: true,
            index: true
        },
        inAppEnabled: { type: Boolean, default: true, required: true },
        emailEnabled: { type: Boolean, default: false },
        telegramEnabled: { type: Boolean, default: false },
        whatsappEnabled: { type: Boolean, default: false },
        emailVerified: { type: Boolean, default: false },
        telegramVerified: { type: Boolean, default: false },
        whatsappVerified: { type: Boolean, default: false },
        preferences: {
            bookingUpdates: { type: Boolean, default: true },
            bookingReminders: { type: Boolean, default: true },
            orderUpdates: { type: Boolean, default: true },
            marketing: { type: Boolean, default: false }
        }
    },
    {
        timestamps: { createdAt: false, updatedAt: true }
    }
);

// In-app can never be switched off — it is the durable record.
CustomerNotificationPreferenceSchema.pre('save', function (next) {
    if (this.inAppEnabled === false) {
        this.inAppEnabled = true;
    }
    next();
});

export const CustomerNotificationPreferenceModel =
    (mongoose.models.CustomerNotificationPreference as mongoose.Model<ICustomerNotificationPreference>) ||
    mongoose.model<ICustomerNotificationPreference>(
        MODELS.CUSTOMER_NOTIFICATION_PREFERENCE,
        CustomerNotificationPreferenceSchema,
        COLLECTIONS.CUSTOMER_NOTIFICATION_PREFERENCE
    );
