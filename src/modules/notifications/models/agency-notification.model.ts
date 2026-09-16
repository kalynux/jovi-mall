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
    /**
     * The agent↔agency contract handshake, from the agency's side. Distinct
     * from `connection.*` above, which is the vendor↔agency one: the two
     * relationships have different counterparties and different copy, and the
     * agency is on the receiving end of both.
     */
    | 'agent_contract.request_received'
    | 'agent_contract.approved'
    | 'agent_contract.rejected'
    /**
     * A contract transition this agency must answer — an agent asking to leave,
     * most often — and the answer when it comes. The handshake trio above forms
     * a contract; these change one that already exists, and were silent until
     * now on the reasoning that the status-request inbox is their home. That
     * left a departure request invisible until someone opened the tab.
     */
    | 'agent_contract.status_request_raised'
    | 'agent_contract.status_request_resolved'
    /**
     * Terms negotiation — the mirror of the agent stack's trio.
     * `terms_countered` is a PENDING contract whose offer moved back to this
     * agency; `terms_proposed` is a change to a LIVE one, in force only on
     * acceptance; `terms_resolved` is the answer to either.
     */
    | 'agent_contract.terms_countered'
    | 'agent_contract.terms_proposed'
    | 'agent_contract.terms_resolved'
    | 'shipment.assigned'
    /** An agent accepted the shipment offer — it's now theirs. */
    | 'shipment.offer.accepted'
    /** No agent accepted (declined / timed out / pool exhausted) — assign manually. */
    | 'shipment.assignment.unfilled'
    /**
     * The agency's AGENT advanced a shipment from the agent app. One situation
     * per outcome rather than one parameterised by status — the render context
     * is built before the agency's language is resolved, so a status label would
     * leak English into a localized body. `in_transit` is deliberately absent:
     * it is a routine progress ping, not something to push at an agency.
     */
    | 'shipment.agent.picked_up'
    | 'shipment.agent.delivered'
    | 'shipment.agent.failed'
    | 'shipment.agent.returned'
    | 'payout.requested'
    | 'payout.paid'
    | 'payout.rejected'
    /**
     * The gateway did not complete the transfer.
     *
     * ⚠ **Not terminal, and not a rejection.** A rejected payout returns the amount to the
     * available balance; this one leaves it held in `requested_balance`, so the agency cannot
     * request again (one open request per owner) until an administrator retries the send or
     * rejects it. Published since the payout-execution work and consumed by nothing until
     * now — the only payout outcome where silence freezes money.
     */
    | 'payout.transfer_failed'
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
    | 'storage.alert'
    /**
     * Stock adjustment on a SKU this agency warehouses. Neither party moves
     * `variant.stock` alone on such a SKU, so all three of these are the agency
     * being told about the other half of a negotiation it is party to:
     * `received` — the vendor proposed a quantity, and it is this agency's to answer;
     * `approved` / `rejected` — the vendor answered a proposal this agency made.
     *
     * There is no `withdrawn` situation, matching `connection.*`: retracting a
     * request nobody acted on is not news worth pushing.
     */
    | 'storage.stock_request.received'
    | 'storage.stock_request.approved'
    | 'storage.stock_request.rejected';
export type AgencyAggregateType =
    | 'connection'
    /** An agent↔agency contract — NOT a vendor↔agency connection. */
    | 'contract'
    | 'shipment'
    | 'payout'
    | 'deposit'
    | 'plan'
    /** MEDIA storage quota (`storage.alert`) — not product warehousing. */
    | 'storage'
    /**
     * A `StockAdjustmentRequest`. Deliberately NOT folded into `storage` above:
     * that one means the media-file quota, and one aggregate type meaning two
     * unrelated things is how a deep-link ends up on the wrong screen.
     */
    | 'stock_request';

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
        // Must list every member of AgencyNotificationType above. The eight
        // `agent_contract.*` values and the `contract` aggregate were missing here
        // and only went unnoticed because `createIfNotExists` upserts through
        // `findOneAndUpdate` WITHOUT `runValidators` — they are restored below rather
        // than left for the first caller that reaches for `.save()`.
        type: {
            type: String,
            enum: [
                'connection.request_received',
                'connection.approved',
                'connection.rejected',
                'connection.reapproval_needed',
                'agent_contract.request_received',
                'agent_contract.approved',
                'agent_contract.rejected',
                'agent_contract.status_request_raised',
                'agent_contract.status_request_resolved',
                'agent_contract.terms_countered',
                'agent_contract.terms_proposed',
                'agent_contract.terms_resolved',
                'shipment.assigned',
                'shipment.offer.accepted',
                'shipment.assignment.unfilled',
                'shipment.agent.picked_up',
                'shipment.agent.delivered',
                'shipment.agent.failed',
                'shipment.agent.returned',
                'payout.requested',
                'payout.paid',
                'payout.rejected',
                // ⚠ Added here as well as to the union above — this list is hand-kept, as the
                // comment on it says, and the eight `agent_contract.*` values were once
                // missing from exactly this array. A situation in the union and absent here
                // throws a ValidationError on `.save()`, which the upsert path hides.
                'payout.transfer_failed',
                'cod.deposit.declared',
                'cod.deposit.direct_to_platform',
                'plan.expiring',
                'plan.expired',
                'shipment.cap.exceeded',
                'storage.alert',
                'storage.stock_request.received',
                'storage.stock_request.approved',
                'storage.stock_request.rejected'
            ],
            required: true
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        aggregateType: {
            type: String,
            enum: ['connection', 'contract', 'shipment', 'payout', 'deposit', 'plan', 'storage', 'stock_request'],
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
