import { eventBus } from '../../core/events/event-bus';
import { VendorNotificationEventHandler } from './services/vendor-notification-event-handler.service';
import { assertCatalogComplete } from './catalog/notification-catalog';
import { isFcmConfigured } from '../../config/fcm.config';

/**
 * Initialize Vendor Notification Event Consumers
 * 
 * Registers all notification event handlers on app startup.
 * 
 * CRITICAL: Payment events are split into partial and full.
 */
export function initializeVendorNotificationEventConsumers(): void {
    // Fail fast on an incomplete localized catalog before wiring handlers.
    assertCatalogComplete();

    const handler = new VendorNotificationEventHandler();

    // Subscribe to split payment events
    eventBus.subscribe('order.created', handler.handleOrderCreated.bind(handler));
    eventBus.subscribe('order.cancelled', handler.handleOrderCancelled.bind(handler));
    eventBus.subscribe('booking.created', handler.handleBookingCreated.bind(handler));
    eventBus.subscribe('booking.cancelled', handler.handleBookingCancelled.bind(handler));
    eventBus.subscribe('payment.received.partial', handler.handlePaymentReceivedPartial.bind(handler));
    eventBus.subscribe('payment.received.full', handler.handlePaymentReceivedFull.bind(handler));
    eventBus.subscribe('vendor.storage.alert', handler.handleStorageAlert.bind(handler));
    eventBus.subscribe('connection.request_received', handler.handleConnectionRequestReceived.bind(handler));
    eventBus.subscribe('connection.approved', handler.handleConnectionApproved.bind(handler));
    eventBus.subscribe('connection.rejected', handler.handleConnectionRejected.bind(handler));
    eventBus.subscribe('connection.reapproval_needed', handler.handleConnectionReapprovalNeeded.bind(handler));
    eventBus.subscribe('payout.requested', handler.handlePayoutRequested.bind(handler));
    eventBus.subscribe('payout.paid', handler.handlePayoutPaid.bind(handler));
    eventBus.subscribe('payout.rejected', handler.handlePayoutRejected.bind(handler));
    eventBus.subscribe('shipment.rejected', handler.handleShipmentRejected.bind(handler));
    // Subscription plan lifecycle (owner-typed; handler no-ops on non-vendor owners).
    eventBus.subscribe('plan.expiring', handler.handlePlanExpiring.bind(handler));
    eventBus.subscribe('plan.expired', handler.handlePlanExpired.bind(handler));

    console.log(
        `[VendorNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
