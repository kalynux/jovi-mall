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
    /**
     * ⚠ **This event had NO subscriber on any stack** — published by
     * `payout-request.service.ts:580` and consumed by nothing. It is the only payout outcome
     * where silence freezes money: rejected returns the funds, failed leaves them held with
     * the owner unable to re-request.
     */
    eventBus.subscribe('payout.transfer_failed', handler.handlePayoutTransferFailed.bind(handler));
    eventBus.subscribe('shipment.rejected', handler.handleShipmentRejected.bind(handler));
    // Subscription plan lifecycle (owner-typed; handler no-ops on non-vendor owners).
    eventBus.subscribe('plan.expiring', handler.handlePlanExpiring.bind(handler));
    eventBus.subscribe('plan.expired', handler.handlePlanExpired.bind(handler));
    // Agency-warehoused stock. The first three are shared with the agency consumer
    // and discriminated on `recipientRole` — each handler no-ops on payloads that
    // aren't theirs, the same pattern `connection.*` uses. The last three are
    // vendor-only: the agency took the action, so it needs no telling.
    eventBus.subscribe('storage.stock_request.received', handler.handleStockRequestReceived.bind(handler));
    eventBus.subscribe('storage.stock_request.approved', handler.handleStockRequestApproved.bind(handler));
    eventBus.subscribe('storage.stock_request.rejected', handler.handleStockRequestRejected.bind(handler));
    eventBus.subscribe('storage.depot_changed', handler.handleStorageDepotChanged.bind(handler));
    eventBus.subscribe('storage.product_suspended', handler.handleStorageProductSuspended.bind(handler));
    eventBus.subscribe('storage.product_unsuspended', handler.handleStorageProductUnsuspended.bind(handler));

    console.log(
        `[VendorNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
