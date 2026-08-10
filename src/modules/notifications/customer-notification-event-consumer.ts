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

    // ── Delivery progress ───────────────────────────────────────────────────
    // Only four shipment statuses reach the customer (shipped / out for delivery /
    // delivered / failed). The handler drops the rest — `assigned`, `handing_over`
    // and friends are internal logistics, and forwarding them would train people
    // to ignore the channel that matters.
    eventBus.subscribe('shipment.status_changed', handler.handleShipmentStatusChanged.bind(handler));

    console.log(
        `[CustomerNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
