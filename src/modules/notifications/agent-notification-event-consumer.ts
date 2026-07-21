import { eventBus } from '../../core/events/event-bus';
import { AgentNotificationEventHandler } from './services/agent-notification-event-handler.service';
import { assertAgentCatalogComplete } from './catalog/agent-notification-catalog';
import { isFcmConfigured } from '../../config/fcm.config';

/**
 * Initialize Agent Notification Event Consumers
 *
 * Third multi-channel consumer, registering on app startup alongside the vendor
 * and agency ones.
 *
 * Note `cod.deposit.recorded` is ALSO subscribed by the agency consumer, for the
 * direct-to-platform case (the agency's own liability falls without them doing
 * anything). Each handler no-ops on payloads that are not theirs, the same way
 * the shared connection.* events already work.
 *
 * `cod.deposit.declared` is deliberately NOT handled here: the agent is the one
 * who declared it, so telling them about it is noise. It goes to the agency,
 * who has to answer it.
 */
export function initializeAgentNotificationEventConsumers(): void {
    assertAgentCatalogComplete();

    const handler = new AgentNotificationEventHandler();

    eventBus.subscribe('cod.deposit.recorded', handler.handleDepositRecorded.bind(handler));
    eventBus.subscribe('cod.deposit.rejected', handler.handleDepositRejected.bind(handler));

    // Agent-acceptance workflow: a new offer to answer, and the timeout that
    // lapsed one they didn't. The accept/reject confirmations are deliberately
    // NOT notified — the agent took the action, so telling them is noise (the
    // same reason `cod.deposit.declared` is not sent to the agent).
    eventBus.subscribe('shipment.offer_created', handler.handleOfferReceived.bind(handler));
    eventBus.subscribe('shipment.offer_expired', handler.handleOfferExpired.bind(handler));

    // Reassignment: the previous agent is told they're off the shipment (and their
    // live access to it is already revoked by the detach).
    eventBus.subscribe('shipment.reassigned', handler.handleReassignedAway.bind(handler));

    console.log(
        `[AgentNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
