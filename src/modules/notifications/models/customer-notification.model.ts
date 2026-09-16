import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Customer Notification
 *
 * Fourth multi-channel stack, alongside vendor / agency / agent — in-app, push,
 * and (per preference) one secondary channel of email/telegram/whatsapp, all
 * catalog- and i18n-driven. See customer-notification-catalog.ts and
 * customer-notification-preference.model.ts.
 *
 * ── Why customers needed their own stack ────────────────────────────────────
 *
 * The customer was the only party on the platform who was never told anything.
 * A vendor learned about every booking and order; the customer who *placed* them
 * learned nothing — not when a vendor accepted their appointment, not when a
 * vendor cancelled it out from under them, not when their parcel shipped. The
 * only customer-facing message that existed anywhere was the COD delivery code.
 *
 * The asymmetry mattered most on bookings, where the platform tracks a `no-show`
 * status against a customer who was never reminded the appointment existed.
 *
 * The three sibling stacks are deliberately NOT DRY'd into one generic engine,
 * and this one follows that: the copy is written per-audience and the situations
 * barely overlap. A customer is told what happens to *their* order; a vendor is
 * told what happens to *their business*. Same event, different message.
 */
export type CustomerNotificationType =
    // ── Bookings ────────────────────────────────────────────────────────────
    /** The booking was created. Says whether it is confirmed or awaiting the vendor. */
    | 'booking.created'
    /** A `manual` booking the vendor has now accepted. */
    | 'booking.confirmed'
    /** Moved to a different time (by either side). */
    | 'booking.rescheduled'
    /** Called off. Copy differs by who did it — see the catalog. */
    | 'booking.cancelled'
    /** The appointment happened and was settled. */
    | 'booking.completed'
    /**
     * The appointment is coming up. Time-based, from BookingReminderWorker rather
     * than an event — and the reason this stack exists at all, since `no-show` is
     * a status the platform holds against a customer nobody reminded.
     */
    | 'booking.reminder'
    /** Payment for the booking succeeded — the original price, or a balance paid later. */
    | 'booking.payment.received'
    /**
     * A mobile-money charge for a booking did not go through — the original price or a balance.
     *
     * ⚠ **The same silence `order.payment_failed` closed, one product type over.** Until this
     * existed an online booking payment was never announced at all: success published an event only
     * the vendor heard, and failure published nothing. A customer who approved nothing, or whose
     * prompt timed out, was told nothing and turned up for an appointment the vendor saw as unpaid.
     *
     * ⚠ **It must never imply the booking is cancelled.** Nothing about a failed charge cancels
     * one; the copy says what happened and where to try again.
     */
    | 'booking.payment_failed'
    /**
     * The service ran longer (or cost more) than quoted and a balance is now
     * payable. Never silently charged — this message IS the request.
     */
    | 'booking.balance.due'
    /** Money is coming back after a cancellation. */
    | 'booking.refunded'
    /**
     * A refund is owed but could not be returned automatically (cash, or a
     * gateway whose refund API is not implemented). Says a human is on it, so the
     * customer is not left wondering where their money went.
     */
    | 'booking.refund.pending'

    // ── Orders (physical/digital goods) ─────────────────────────────────────
    | 'order.created'
    | 'order.payment.received'
    /**
     * A card payment page is waiting to be opened (GAP-008 + GAP-012).
     *
     * ⚠ **The one situation in this catalog with no platform event behind it**, and the
     * only one the automation layer triggers rather than observes. The platform cannot
     * know that a customer chose "card" in a chat and then stopped writing — only the
     * conversation knows that. Everything else here is the consequence of something the
     * platform did.
     *
     * It exists because a card is the one payment method that CANNOT complete in chat: a
     * client secret is confirmable only by Stripe.js in a browser. So the chat hands over
     * a link, and if the service window has closed by then this is the approved template
     * that carries it. Mobile money needs none of this and never raises it.
     */
    | 'order.payment_link'
    /**
     * The money did not go through — the charge was declined, timed out, or the customer
     * never approved the push on their handset.
     *
     * ⚠ **Added because its ABSENCE was the defect.** Every other outcome of a checkout told
     * the customer something; this one told them nothing at all, so a failed payment looked
     * exactly like a successful one that had gone quiet. The customer waits for an order that
     * is not coming, and the vendor loses a sale nobody knows was lost.
     *
     * ⚠ **It must never imply the order is gone.** A failed payment leaves the order
     * recoverable — the basket is intact and the charge can be retried — so the copy says what
     * happened and offers the retry, rather than apologising for a cancellation that has not
     * occurred.
     */
    | 'order.payment_failed'
    /** Left the vendor/depot and is on its way. */
    | 'order.shipped'
    /** An agent is carrying it now — the last useful "be around" signal. */
    | 'order.out_for_delivery'
    | 'order.delivered'
    /** The delivery attempt failed; says what happens next. */
    | 'order.delivery_failed'
    | 'order.cancelled'
    | 'order.refunded'

    // ── Support tickets (GAP-012) ───────────────────────────────────────────
    // The one row of GAP-012's "flows that finish after the customer stops
    // writing" table that had NO notification at all. `ticket.*` events have been
    // published since the module shipped and nothing ever subscribed, so a
    // customer who asked a question — through the bot or anywhere else — was
    // never told it had been answered.
    //
    // Only three of the eight statuses reach the customer, and the omitted ones
    // are omitted on the same rule the shipment handler follows: internal
    // progress is not news. `in_progress` and `waiting_on_{admin,vendor,agency,
    // agent}` all mean "somebody else is working on it", and forwarding them
    // would train people to ignore the channel that carries the answer.
    /** Somebody who is not the customer added a PUBLIC note. The answer arrived. */
    | 'ticket.replied'
    /** Now `waiting_on_customer` — the platform is blocked on them. */
    | 'ticket.awaiting_customer'
    /** Reached `resolved` or `closed`. */
    | 'ticket.resolved';

export type CustomerAggregateType = 'booking' | 'order' | 'shipment' | 'payment' | 'ticket';

/**
 * Deep-link action for a notification, localized in the customer's language.
 * Mirrors AgentNotificationAction.
 */
export interface CustomerNotificationAction {
    label: string;
    path: string;
    url?: string;
}

export type CustomerDeliveryChannel = 'in-app' | 'email' | 'telegram' | 'whatsapp' | 'push';

/**
 * Every situation above, as a runtime array.
 *
 * The Mongoose enum below is built FROM this, rather than being a second
 * hand-maintained list. The agent stack keeps two copies and they have already
 * drifted — six of its situation types are missing from its schema enum, so
 * writing one throws a ValidationError at the moment it matters. One source here
 * makes that impossible.
 */
export const CUSTOMER_NOTIFICATION_TYPES: readonly CustomerNotificationType[] = [
    'booking.created',
    'booking.confirmed',
    'booking.rescheduled',
    'booking.cancelled',
    'booking.completed',
    'booking.reminder',
    'booking.payment.received',
    'booking.payment_failed',
    'booking.balance.due',
    'booking.refunded',
    'booking.refund.pending',
    'order.created',
    'order.payment.received',
    'order.payment_link',
    'order.payment_failed',
    'order.shipped',
    'order.out_for_delivery',
    'order.delivered',
    'order.delivery_failed',
    'order.cancelled',
    'order.refunded',
    'ticket.replied',
    'ticket.awaiting_customer',
    'ticket.resolved'
] as const;

/**
 * Every aggregate a customer notification can hang off, as a runtime array.
 *
 * Exists for the same reason `CUSTOMER_NOTIFICATION_TYPES` does — the schema enum below is
 * spread from it rather than re-typed, so the union and the enum cannot drift.
 */
export const CUSTOMER_AGGREGATE_TYPES: readonly CustomerAggregateType[] = [
    'booking',
    'order',
    'shipment',
    'payment',
    'ticket'
] as const;

const DELIVERY_CHANNELS: readonly CustomerDeliveryChannel[] = [
    'in-app',
    'email',
    'telegram',
    'whatsapp',
    'push'
] as const;

export interface ICustomerNotification extends Document {
    customerId: mongoose.Types.ObjectId;
    type: CustomerNotificationType;
    title: string;
    message: string;
    aggregateType: CustomerAggregateType;
    aggregateId: mongoose.Types.ObjectId;
    action?: CustomerNotificationAction;
    deliveredVia: CustomerDeliveryChannel[];
    deliveryErrors?: Array<{ channel: CustomerDeliveryChannel; error: string; failedAt: Date }>;
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
}

const CustomerNotificationSchema = new Schema<ICustomerNotification>(
    {
        customerId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.CUSTOMER,
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: [...CUSTOMER_NOTIFICATION_TYPES],
            required: true
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        message: { type: String, required: true, trim: true, maxlength: 1000 },
        aggregateType: {
            type: String,
            // Spread from the array, never re-typed. This enum WAS a hand-kept literal and
            // GAP-012 is exactly the change that would have broken it: adding `ticket` to
            // the union without adding it here throws a ValidationError on every ticket
            // notification, which is the drift that left all eight `agent_contract.*`
            // situations undeliverable in the agent stack. Same rule, same reason.
            enum: [...CUSTOMER_AGGREGATE_TYPES],
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
            enum: [...DELIVERY_CHANNELS],
            default: ['in-app'],
            required: true
        },
        deliveryErrors: {
            type: [
                new Schema(
                    {
                        channel: { type: String, enum: [...DELIVERY_CHANNELS], required: true },
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
        /**
         * One notification per (situation, aggregate, recipient). The unique index
         * is what makes a redelivered event, a worker restart mid-sweep, or a
         * retried webhook safe — the second write is rejected rather than
         * duplicating the message.
         */
        idempotencyKey: { type: String, required: true, unique: true, index: true }
    },
    {
        timestamps: { createdAt: true, updatedAt: false }
    }
);

// In-app is the durable record and is always present, whatever else succeeded.
CustomerNotificationSchema.pre('save', function (next) {
    if (!this.deliveredVia.includes('in-app')) {
        this.deliveredVia.unshift('in-app');
    }
    next();
});

CustomerNotificationSchema.index({ customerId: 1, createdAt: -1 });
CustomerNotificationSchema.index({ customerId: 1, isRead: 1 });

export const CustomerNotificationModel =
    (mongoose.models.CustomerNotification as mongoose.Model<ICustomerNotification>) ||
    mongoose.model<ICustomerNotification>(
        MODELS.CUSTOMER_NOTIFICATION,
        CustomerNotificationSchema,
        COLLECTIONS.CUSTOMER_NOTIFICATION
    );
