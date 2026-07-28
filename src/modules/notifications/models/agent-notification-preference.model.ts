import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Agent Notification Preferences
 *
 * Mirrors agency-notification-preference.model.ts. Same rules:
 * - in-app is always enabled (non-configurable)
 * - Only ONE secondary channel can be enabled at a time
 * - Secondary channels require verification before enabling
 * - When enabling a new secondary channel, others are auto-disabled
 *
 * Note `preferences` is per-agent, NOT per-membership, and that is deliberate:
 * it follows the agent domain's rule that a value which cannot differ per agency
 * belongs on the agent. An agent does not want deposit alerts from agency A but
 * not agency B — they want to know when their own money moves, full stop.
 */
export interface IAgentNotificationPreference extends Document {
    agentId: mongoose.Types.ObjectId;

    // Channel enablement (only one secondary channel allowed)
    inAppEnabled: boolean; // Always true, non-configurable
    emailEnabled: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;

    // Verification status (checked live from the agent model and link services)
    emailVerified: boolean;
    telegramVerified: boolean;
    whatsappVerified: boolean;

    // Event type preferences
    preferences: {
        /**
         * Covers all three cod.deposit.* situations (recorded, confirmed,
         * rejected). Defaults ON, and there is a real argument it should not be
         * switchable at all: these are the messages that tell an agent their cash
         * liability moved, and an agent who turns them off loses the only signal
         * that an agency under-recorded a hand-over. Kept configurable for
         * consistency with the vendor/agency stacks, but see the docstring on
         * agent-notification.model.ts.
         */
        codDepositUpdates: boolean;
        /**
         * Assignment offers (shipment.offer.received / .expired). Defaults ON —
         * an offer expires on a timeout, so an agent who misses it loses work;
         * push is the load-bearing channel here. Gates only the one secondary
         * channel (in-app + push are always delivered).
         */
        assignmentOffers: boolean;
        /** Subscription plan lifecycle (plan.expiring / plan.expired). */
        planUpdates: boolean;
        /** The agent's own media storage threshold alerts (storage.alert, 80/90/100%). */
        storageAlert: boolean;
    };

    updatedAt: Date;
}

const AgentNotificationPreferenceSchema = new Schema<IAgentNotificationPreference>(
    {
        agentId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.DELIVERY_AGENT,
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
            codDepositUpdates: {
                type: Boolean,
                default: true
            },
            assignmentOffers: {
                type: Boolean,
                default: true
            },
            planUpdates: {
                type: Boolean,
                default: true
            },
            storageAlert: {
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
AgentNotificationPreferenceSchema.pre('save', function (next) {
    if (this.inAppEnabled === false) {
        this.inAppEnabled = true;
    }
    next();
});

export const AgentNotificationPreferenceModel =
    (mongoose.models.AgentNotificationPreference as mongoose.Model<IAgentNotificationPreference>) ||
    mongoose.model<IAgentNotificationPreference>(
        MODELS.AGENT_NOTIFICATION_PREFERENCE,
        AgentNotificationPreferenceSchema,
        COLLECTIONS.AGENT_NOTIFICATION_PREFERENCE
    );
