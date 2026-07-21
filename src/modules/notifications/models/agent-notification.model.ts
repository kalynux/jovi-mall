import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Agent Notification
 *
 * Third multi-channel stack, alongside vendor-notification.model.ts and
 * agency-notification.model.ts — in-app, push, and (per preference) one
 * secondary channel of email/telegram/whatsapp, all catalog/i18n-driven. See
 * agent-notification-catalog.ts and agent-notification-preference.model.ts.
 *
 * ── Why agents needed their own stack ───────────────────────────────────────
 *
 * Agents had NO notification surface at all — only device tokens. That was
 * survivable while everything about an agent's work was pushed to them by their
 * agency, but the COD cash chain made it a fairness problem: an agency's record
 * of a cash hand-over moves the agent's money, and until now the agent was never
 * told it happened. `cod.deposit.recorded` with no prior declaration is the case
 * that matters most — it is the only way an agent can notice an under-recorded
 * hand-over, so it is the one situation here that must never be silent.
 *
 * That is also why this is an in-app record and not just a push: push is
 * best-effort and ephemeral (no device registered, FCM off → nothing), and these
 * notifications are cash evidence an agent may need to point at later.
 */
export type AgentNotificationType =
    | 'cod.deposit.recorded'
    | 'cod.deposit.confirmed'
    | 'cod.deposit.rejected'
    /** A new shipment assignment offer to accept/reject before it times out. */
    | 'shipment.offer.received'
    /** An offer the agent didn't answer in time lapsed. */
    | 'shipment.offer.expired'
    /**
     * The agent was taken off a shipment they were handling (reassigned to
     * another agent). Tells them they are no longer responsible for it — and,
     * with the detach, their live access to it is already gone.
     */
    | 'shipment.reassigned_away';
export type AgentAggregateType = 'deposit' | 'offer' | 'shipment';

/**
 * Deep-link action for a notification, localized in the agent's language.
 * Mirrors agency-notification.model.ts's AgencyNotificationAction.
 */
export interface AgentNotificationAction {
    label: string;
    path: string;
    url?: string;
}

export type AgentDeliveryChannel = 'in-app' | 'email' | 'telegram' | 'whatsapp' | 'push';

export interface IAgentNotification extends Document {
    agentId: mongoose.Types.ObjectId;
    type: AgentNotificationType;
    title: string;
    message: string;
    aggregateType: AgentAggregateType;
    aggregateId: mongoose.Types.ObjectId;
    action?: AgentNotificationAction;
    deliveredVia: AgentDeliveryChannel[];
    deliveryErrors?: Array<{ channel: AgentDeliveryChannel; error: string; failedAt: Date }>;
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
}

const AgentNotificationSchema = new Schema<IAgentNotification>(
    {
        agentId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.DELIVERY_AGENT,
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: [
                'cod.deposit.recorded',
                'cod.deposit.confirmed',
                'cod.deposit.rejected',
                'shipment.offer.received',
                'shipment.offer.expired'
            ],
            required: true
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        aggregateType: { type: String, enum: ['deposit', 'offer'], required: true },
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
AgentNotificationSchema.pre('save', function (next) {
    if (!this.deliveredVia.includes('in-app')) {
        this.deliveredVia.unshift('in-app');
    }
    next();
});

AgentNotificationSchema.index({ agentId: 1, createdAt: -1 });
AgentNotificationSchema.index({ agentId: 1, isRead: 1 });

export const AgentNotificationModel =
    (mongoose.models.AgentNotification as mongoose.Model<IAgentNotification>) ||
    mongoose.model<IAgentNotification>(MODELS.AGENT_NOTIFICATION, AgentNotificationSchema, COLLECTIONS.AGENT_NOTIFICATION);
