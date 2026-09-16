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

    // The AGENT contract handshake — a different relationship from the
    // connection.* events above, shared with the agent consumer on the same
    // recipientRole discriminator.
    eventBus.subscribe('agent_contract.request_received', handler.handleAgentContractRequestReceived.bind(handler));
    eventBus.subscribe('agent_contract.approved', handler.handleAgentContractApproved.bind(handler));
    eventBus.subscribe('agent_contract.rejected', handler.handleAgentContractRejected.bind(handler));
    eventBus.subscribe(
        'agent_contract.status_request_raised',
        handler.handleAgentContractStatusRequestRaised.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.status_request_resolved',
        handler.handleAgentContractStatusRequestResolved.bind(handler)
    );

    // Terms negotiation — the terms of the bargain rather than its status.
    eventBus.subscribe(
        'agent_contract.terms_countered',
        handler.handleAgentContractTermsCountered.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.terms_proposed',
        handler.handleAgentContractTermsProposed.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.terms_resolved',
        handler.handleAgentContractTermsResolved.bind(handler)
    );

    eventBus.subscribe('shipment.assigned', handler.handleShipmentAssigned.bind(handler));
    // Agent-acceptance workflow: an agent accepted, or nobody did (assign manually).
    eventBus.subscribe('shipment.offer_accepted', handler.handleOfferAccepted.bind(handler));
    eventBus.subscribe('shipment.no_agent_available', handler.handleAssignmentUnfilled.bind(handler));
    // The agency's agent advanced a shipment from the agent app. Emitted only
    // for picked_up / agent_delivered / failed / returned — see
    // AGENT_TRANSITIONS_NOTIFYING_AGENCY in shipment.service.ts.
    eventBus.subscribe('shipment.agent_status_changed', handler.handleAgentStatusChanged.bind(handler));
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
    eventBus.subscribe('cod.deposit.declared', handler.handleCodDepositDeclared.bind(handler));
    // Shared with the agent consumer — this handler only acts on the
    // direct-to-platform case, where the agency's liability moved without them.
    eventBus.subscribe('cod.deposit.recorded', handler.handleCodDepositRecorded.bind(handler));
    // Subscription plan lifecycle (owner-typed; handler no-ops on non-agency owners)
    // + the unterminated-shipment soft-cap alert.
    eventBus.subscribe('plan.expiring', handler.handlePlanExpiring.bind(handler));
    eventBus.subscribe('plan.expired', handler.handlePlanExpired.bind(handler));
    eventBus.subscribe('agency.shipment_cap.exceeded', handler.handleShipmentCapExceeded.bind(handler));
    // Media storage threshold alerts (80/90/100%), from the file-cleanup sweep.
    eventBus.subscribe('agency.storage.alert', handler.handleStorageAlert.bind(handler));
    // Stock adjustment on a warehoused SKU. Shared with the vendor consumer and
    // discriminated on `recipientRole` — the same pattern `connection.*` uses.
    // Nothing to do with `agency.storage.alert` above, which is the media quota.
    eventBus.subscribe('storage.stock_request.received', handler.handleStockRequestReceived.bind(handler));
    eventBus.subscribe('storage.stock_request.approved', handler.handleStockRequestApproved.bind(handler));
    eventBus.subscribe('storage.stock_request.rejected', handler.handleStockRequestRejected.bind(handler));

    console.log(
        `[AgencyNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
