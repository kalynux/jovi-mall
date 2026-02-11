import { eventBus } from '../../core/events/event-bus';
import { VendorNotificationEventHandler } from './services/vendor-notification-event-handler.service';

/**
 * Initialize Vendor Notification Event Consumers
 * 
 * Registers all notification event handlers on app startup.
 * 
 * CRITICAL: Payment events are split into partial and full.
 */
export function initializeVendorNotificationEventConsumers(): void {
    const handler = new VendorNotificationEventHandler();

    // Subscribe to split payment events
    eventBus.subscribe('order.created', handler.handleOrderCreated.bind(handler));
    eventBus.subscribe('order.cancelled', handler.handleOrderCancelled.bind(handler));
    eventBus.subscribe('booking.created', handler.handleBookingCreated.bind(handler));
    eventBus.subscribe('booking.cancelled', handler.handleBookingCancelled.bind(handler));
    eventBus.subscribe('payment.received.partial', handler.handlePaymentReceivedPartial.bind(handler));
    eventBus.subscribe('payment.received.full', handler.handlePaymentReceivedFull.bind(handler));

    console.log('[VendorNotifications] Event handlers registered successfully');
}
