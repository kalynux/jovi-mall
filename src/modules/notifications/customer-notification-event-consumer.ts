import { eventBus } from '../../core/events/event-bus';
import { CustomerNotificationEventHandler } from './services/customer-notification-event-handler.service';
import { assertCustomerCatalogComplete } from './catalog/customer-notification-catalog';
import { isFcmConfigured } from '../../config/fcm.config';

/** Shared instance, so non-event callers (workers) reach the same handler. */
let handlerInstance: CustomerNotificationEventHandler | null = null;

/**
 * The customer notification handler.
 *
 * Exposed because two senders are NOT events: `BookingReminderWorker` (time-based)
 * and the balance-due request raised when a vendor completes a booking above the
 * quoted price. Both call `notify()` directly rather than inventing an event whose
 * only subscriber would be this handler.
 */
export function getCustomerNotificationHandler(): CustomerNotificationEventHandler {
    if (!handlerInstance) handlerInstance = new CustomerNotificationEventHandler();
    return handlerInstance;
}

/**
 * Initialize Customer Notification Event Consumers
 *
 * Fourth multi-channel consumer, registering at startup alongside the vendor,
 * agency and agent ones.
 *
 * Several of these events are ALSO consumed by the vendor stack — `booking.created`
 * and `order.created` most obviously. That is intended and matches how
 * `cod.deposit.recorded` is already shared across the agent and agency stacks:
 * one event, two audiences, two entirely different messages. The vendor is told
 * they have work; the customer is told what they bought.
 */
export function initializeCustomerNotificationEventConsumers(): void {
    // Fail the boot rather than ship a half-translated catalog — the same guard
    // the three sibling stacks use.
    assertCustomerCatalogComplete();

    const handler = getCustomerNotificationHandler();

    // ── Bookings ────────────────────────────────────────────────────────────
    eventBus.subscribe('booking.created', handler.handleBookingCreated.bind(handler));
    eventBus.subscribe('booking.confirmed', handler.handleBookingConfirmed.bind(handler));
    eventBus.subscribe('booking.rescheduled', handler.handleBookingRescheduled.bind(handler));
    eventBus.subscribe('booking.cancelled', handler.handleBookingCancelled.bind(handler));
    eventBus.subscribe('booking.completed', handler.handleBookingCompleted.bind(handler));
    // Covers paid / refunded / refund_pending; the handler ignores the rest.
    eventBus.subscribe('booking.payment.updated', handler.handleBookingPaymentUpdated.bind(handler));

    // ── Orders ──────────────────────────────────────────────────────────────
    eventBus.subscribe('order.created', handler.handleOrderCreated.bind(handler));
    eventBus.subscribe('order.cancelled', handler.handleOrderCancelled.bind(handler));
    // Also fires for plan purchases and credit top-ups; the handler no-ops on
    // payloads carrying no orderId, the same way the shared cod.* events do.
    eventBus.subscribe('payment.received.full', handler.handleOrderPaymentReceived.bind(handler));
    /**
     * ⭐ The other half of that sentence, and it had no publisher and no subscriber at all.
     *
     * `PaymentOrchestratorService` announced every success and announced no failure on any
     * path, so a refused mobile-money push reached the customer as silence — indistinguishable
     * from a payment that had worked and gone quiet. They waited for an order that was not
     * coming.
     *
     * ⚠ **It covers the reconciliation sweep as well as the webhook**, because the orchestrator
     * publishes from `verifyPayment` too and `PaymentReconciliationWorker` closes a lost
     * callback through exactly that method. The customer whose failure is only discovered ten
     * minutes later by the cron is the one who has been in the dark longest.
     */
    eventBus.subscribe('payment.failed', handler.handleOrderPaymentFailed.bind(handler));

    /**
     * ⭐ The BOOKING half of the same two events — one event per payment, each handler filtering
     * on `aggregateType`, exactly as the order handlers above already do.
     *
     * An online booking payment was never announced to the customer in either direction: success
     * was published and only the vendor stack listened, and failure was not published at all.
     * Both subscriptions are needed for success because the event name compares the payment with
     * the original price — the handler routes on `purpose`, never on full vs partial.
     */
    eventBus.subscribe('payment.received.full', handler.handleBookingPaymentReceived.bind(handler));
    eventBus.subscribe('payment.received.partial', handler.handleBookingPaymentReceived.bind(handler));
    eventBus.subscribe('payment.failed', handler.handleBookingPaymentFailed.bind(handler));

    // ── Delivery progress ───────────────────────────────────────────────────
    // Only four shipment statuses reach the customer (shipped / out for delivery /
    // delivered / failed). The handler drops the rest — `assigned`, `handing_over`
    // and friends are internal logistics, and forwarding them would train people
    // to ignore the channel that matters.
    eventBus.subscribe('shipment.status_changed', handler.handleShipmentStatusChanged.bind(handler));

    // ── Support requests (GAP-012) ──────────────────────────────────────────
    // Both events have been published since the tickets module shipped and had NO
    // subscriber at all — they were two of the 32 names that collapse to
    // `eventBusPublishedTotal{event_type="unhandled"}`. The consequence was the row of
    // GAP-012's table with no notification behind it: a customer who asked a question was
    // never told it had been answered, on any channel.
    //
    // Both handlers filter hard and drop most of what they receive: only PUBLIC notes by
    // somebody other than the customer, and only three of the eight statuses. A ticket
    // opened by a vendor, agency or agent is dropped outright — see `customerTicket`,
    // which is where that gate lives and why it cannot be "does this user have a customer
    // profile" since the GAP-002 D-3 reversal gave every bot user one.
    eventBus.subscribe('ticket.note_created', handler.handleTicketNoteCreated.bind(handler));
    eventBus.subscribe('ticket.status_changed', handler.handleTicketStatusChanged.bind(handler));

    console.log(
        `[CustomerNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
