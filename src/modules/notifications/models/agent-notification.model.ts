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
    /**
     * The agent↔agency contract handshake. An agency asking a specific agent to
     * contract is the case that makes these mandatory rather than nice to have:
     * before the directory existed the agency reached the agent by email, and
     * now there is nothing outside the platform to carry the request at all.
     */
    | 'agent_contract.request_received'
    | 'agent_contract.approved'
    | 'agent_contract.rejected'
    /**
     * A contract transition the COUNTERPARTY must answer — an agency proposing
     * to remove this agent, most often — and the answer when it comes.
     *
     * Distinct from the three above: those are the handshake that FORMS a
     * contract, these are changes to one that already exists. They were silent
     * until now on the reasoning that the status-request inbox is their home,
     * which left a proposed termination invisible until someone happened to open
     * the tab. An inbox nobody is told about is not an inbox.
     */
    | 'agent_contract.status_request_raised'
    | 'agent_contract.status_request_resolved'
    /**
     * Terms negotiation. `terms_countered` is a PENDING contract whose offer
     * moved back to this agent; `terms_proposed` is a change to a LIVE one,
     * which takes effect only on acceptance and whose copy must say so;
     * `terms_resolved` is the answer to either, neutral about whose it was.
     */
    | 'agent_contract.terms_countered'
    | 'agent_contract.terms_proposed'
    | 'agent_contract.terms_resolved'
    /** A new shipment assignment offer to accept/reject before it times out. */
    | 'shipment.offer.received'
    /** A reminder that a still-open offer is waiting (auto-assignment round 2). */
    | 'shipment.offer.reminder'
    /** An offer the agent didn't answer in time lapsed. */
    | 'shipment.offer.expired'
    /**
     * The agent was taken off a shipment they were handling (reassigned to
     * another agent). Tells them they are no longer responsible for it — and,
     * with the detach, their live access to it is already gone.
     */
    | 'shipment.reassigned_away'
    /** Subscription plan lifecycle (billing). */
    | 'plan.expiring'
    | 'plan.expired'
    /** This agent's own media storage crossed a usage threshold (80/90/100%). */
    | 'storage.alert';
export type AgentAggregateType = 'deposit' | 'offer' | 'shipment' | 'contract' | 'plan' | 'storage';

/**
 * Every situation above, as a runtime array. The Mongoose enum is built FROM
 * this rather than hand-maintained beside it.
 *
 * WHY: the schema enum used to be a second copy, and it had drifted — all eight
 * `agent_contract.*` situations were in the union and absent from the enum, so
 * every contract notification (an agency requesting an agent, a proposed
 * termination, a counter-offer) threw a Mongoose ValidationError and the agent
 * was never told. Deriving one from the other makes that class of silence
 * impossible; adding a situation to the union now updates the enum with it.
 */
export const AGENT_NOTIFICATION_TYPES: readonly AgentNotificationType[] = [
    'cod.deposit.recorded',
    'cod.deposit.confirmed',
    'cod.deposit.rejected',
    'agent_contract.request_received',
    'agent_contract.approved',
    'agent_contract.rejected',
    'agent_contract.status_request_raised',
    'agent_contract.status_request_resolved',
    'agent_contract.terms_countered',
    'agent_contract.terms_proposed',
    'agent_contract.terms_resolved',
    'shipment.offer.received',
    'shipment.offer.reminder',
    'shipment.offer.expired',
    'shipment.reassigned_away',
    'plan.expiring',
    'plan.expired',
    'storage.alert'
] as const;

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
            enum: [...AGENT_NOTIFICATION_TYPES],
            required: true
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        // 'contract' was likewise missing here, so even with the type fixed a
        // contract notification would still have failed on this field.
        aggregateType: {
            type: String,
            enum: ['deposit', 'offer', 'shipment', 'contract', 'plan', 'storage'],
            required: true
        },
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
