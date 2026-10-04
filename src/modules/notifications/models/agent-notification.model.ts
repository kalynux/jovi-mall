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
    /**
     * A BULK offer (2026-10-03): one agency sent this agent several shipments in one call.
     * One notification for the batch; a batch of one falls back to `shipment.offer.received`.
     */
    | 'shipment.offer.batch_received'
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
    | 'storage.alert'
    /**
     * The agent's own money leaving the platform.
     *
     * ⚠ **All four are new, and their absence was the defect.** Vendors and agencies have had
     * payout notifications since this stack shipped; this union had none, so an agent
     * requested their money and heard nothing in any channel.
     *
     * ⚠ **`transfer_failed` is not a terminal state and must never be worded like one.** A
     * *rejected* payout returns the funds to the available balance; a *failed* transfer leaves
     * them held in `requested_balance`, so the agent cannot request again
     * (`409 EARNINGS_PAYOUT_ALREADY_PENDING`) and an administrator must retry or reject. It
     * is the only one of the four where silence means money frozen with no signal.
     */
    | 'payout.requested'
    | 'payout.paid'
    | 'payout.rejected'
    | 'payout.transfer_failed'
    /**
     * Per-shipment delivery-fee proposals (2026-10-02) — only ones THIS agent raised.
     * `approved` / `rejected` are the vendor's answer; `edited` is the agency changing the
     * agent's figure; `withdrawn` is the SYSTEM closing it because the shipment moved on
     * (declined, or this agent was detached) — never the agent's own withdrawal, which
     * would be echo. `withdrawn` carries no button: the shipment is no longer theirs.
     */
    | 'delivery_fee_proposal.approved'
    | 'delivery_fee_proposal.rejected'
    | 'delivery_fee_proposal.edited'
    | 'delivery_fee_proposal.withdrawn'
    /** The agency turned its agents' permission to propose delivery fees on / off. */
    | 'fee_proposals.enabled'
    | 'fee_proposals.disabled'
    /**
     * An administrator pinned / released this agent's COD pool. NOT sent for the mass
     * reset to the 500 000 default (that rides the reconcile, trigger ≠ 'override').
     */
    | 'cod.pool.pinned'
    | 'cod.pool.released'
    /**
     * Role closure (ADR-A10). `account.closure_requested` — an administrator asked to close
     * this AGENT account; nothing happens unless the agent confirms while signed in. Gated by
     * NO preference (a muted closure request would expire unseen). Copy says "close", never
     * "delete" (ADR-A02 D-2). `agent_contract.ended_by_closure` — the contracted AGENCY closed
     * its account, so the contract ended; gated by `contractUpdated`.
     */
    | 'account.closure_requested'
    | 'agent_contract.ended_by_closure';
export type AgentAggregateType =
    | 'deposit'
    | 'offer'
    | 'shipment'
    | 'contract'
    | 'plan'
    | 'storage'
    | 'payout'
    /** The agent's own COD pool — `aggregateId` is the agent id. */
    | 'cod_pool'
    /** A bulk offer — `aggregateId` is the batch id, which is NOT an offer id. */
    | 'offer_batch'
    /** A role-closure request (ADR-A10) — `aggregateId` is the request id. */
    | 'account';

/**
 * The aggregate types as a runtime array, for the schema enum to spread.
 *
 * ⚠ **Typed as `readonly AgentAggregateType[]` on purpose** — that annotation is the only
 * thing that makes a missing member a compile error rather than a silent Mongoose
 * ValidationError at write time. Same mechanism as `AGENT_NOTIFICATION_TYPES` below, added
 * for the same reason after the same defect recurred on this exact field.
 */
export const AGENT_AGGREGATE_TYPES: readonly AgentAggregateType[] = [
    'deposit',
    'offer',
    'shipment',
    'contract',
    'plan',
    'storage',
    'payout',
    'cod_pool',
    'offer_batch',
    'account'
];

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
    'shipment.offer.batch_received',
    'shipment.offer.reminder',
    'shipment.offer.expired',
    'shipment.reassigned_away',
    'plan.expiring',
    'plan.expired',
    'storage.alert',
    'payout.requested',
    'payout.paid',
    'payout.rejected',
    'payout.transfer_failed',
    'delivery_fee_proposal.approved',
    'delivery_fee_proposal.rejected',
    'delivery_fee_proposal.edited',
    'delivery_fee_proposal.withdrawn',
    'fee_proposals.enabled',
    'fee_proposals.disabled',
    'cod.pool.pinned',
    'cod.pool.released',
    'account.closure_requested',
    'agent_contract.ended_by_closure'
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
        /**
         * ⚠ **Spread from `AGENT_AGGREGATE_TYPES`, never typed here — and this field is why
         * that rule exists twice in one file.**
         *
         * It used to be a hand-written literal list, and it had drifted exactly as the
         * situation enum had: `'contract'` was in the union and missing from this array, so
         * even with the type fixed a contract notification still failed on THIS field. The
         * comment recording that sat directly above the literal that would do it again.
         *
         * It did do it again. Adding the four `payout.*` situations needed a seventh aggregate
         * type, `'payout'`, and TypeScript could not catch its absence here because a plain
         * string array is not checked against the union — so every agent payout notification
         * would have thrown a Mongoose ValidationError and the agent would have been told
         * nothing, which is the precise silence those four situations were added to end.
         *
         * Derived now. A new aggregate type updates this enum with it.
         */
        aggregateType: {
            type: String,
            enum: [...AGENT_AGGREGATE_TYPES],
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
