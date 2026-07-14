import { eventBus } from '../../core/events/event-bus';
import { AgencyNotificationEventHandler } from './services/agency-notification-event-handler.service';
import { assertAgencyCatalogComplete } from './catalog/agency-notification-catalog';
import { isFcmConfigured } from '../../config/fcm.config';

/**
 * Initialize Agency Notification Event Consumers
 *
 * Multi-channel counterpart to initializeVendorNotificationEventConsumers() —
 * registers on app startup alongside the vendor consumers. connection.* events
 * are shared with the vendor consumer (both subscribe to the same event names;
 * each handler no-ops on payloads whose `recipientRole` isn't theirs — see
 * ConnectionService.notifyVendor/notifyAgency).
 */
export function initializeAgencyNotificationEventConsumers(): void {
    assertAgencyCatalogComplete();

    const handler = new AgencyNotificationEventHandler();

    eventBus.subscribe('connection.request_received', handler.handleConnectionRequestReceived.bind(handler));
    eventBus.subscribe('connection.approved', handler.handleConnectionApproved.bind(handler));
    eventBus.subscribe('connection.rejected', handler.handleConnectionRejected.bind(handler));
    eventBus.subscribe('connection.reapproval_needed', handler.handleConnectionReapprovalNeeded.bind(handler));
    eventBus.subscribe('shipment.assigned', handler.handleShipmentAssigned.bind(handler));
    eventBus.subscribe('payout.requested', handler.handlePayoutRequested.bind(handler));
    eventBus.subscribe('payout.paid', handler.handlePayoutPaid.bind(handler));
    eventBus.subscribe('payout.rejected', handler.handlePayoutRejected.bind(handler));

    console.log(
        `[AgencyNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
