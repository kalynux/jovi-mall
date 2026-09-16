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

    // The agent↔agency contract handshake. Shared with the agency consumer —
    // both subscribe to the same event names and each handler no-ops on
    // payloads whose `recipientRole` isn't theirs, exactly as the connection.*
    // events do across the vendor and agency stacks.
    eventBus.subscribe('agent_contract.request_received', handler.handleContractRequestReceived.bind(handler));
    eventBus.subscribe('agent_contract.approved', handler.handleContractApproved.bind(handler));
    eventBus.subscribe('agent_contract.rejected', handler.handleContractRejected.bind(handler));
    eventBus.subscribe(
        'agent_contract.status_request_raised',
        handler.handleContractStatusRequestRaised.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.status_request_resolved',
        handler.handleContractStatusRequestResolved.bind(handler)
    );

    // Terms negotiation — the terms of the bargain rather than its status.
    eventBus.subscribe(
        'agent_contract.terms_countered',
        handler.handleContractTermsCountered.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.terms_proposed',
        handler.handleContractTermsProposed.bind(handler)
    );
    eventBus.subscribe(
        'agent_contract.terms_resolved',
        handler.handleContractTermsResolved.bind(handler)
    );

    // Agent-acceptance workflow: a new offer to answer, and the timeout that
    // lapsed one they didn't. The accept/reject confirmations are deliberately
    // NOT notified — the agent took the action, so telling them is noise (the
    // same reason `cod.deposit.declared` is not sent to the agent).
    eventBus.subscribe('shipment.offer_created', handler.handleOfferReceived.bind(handler));
    // Auto-assignment round-2 reminder that a still-open offer is waiting.
    eventBus.subscribe('shipment.offer_reminder', handler.handleOfferReminder.bind(handler));
    eventBus.subscribe('shipment.offer_expired', handler.handleOfferExpired.bind(handler));

    // Reassignment: the previous agent is told they're off the shipment (and their
    // live access to it is already revoked by the detach).
    eventBus.subscribe('shipment.reassigned', handler.handleReassignedAway.bind(handler));

    // Subscription plan lifecycle (owner-typed; handler no-ops on non-agent owners).
    eventBus.subscribe('plan.expiring', handler.handlePlanExpiring.bind(handler));
    eventBus.subscribe('plan.expired', handler.handlePlanExpired.bind(handler));

    // Media storage threshold alerts (80/90/100%), from the file-cleanup sweep.
    eventBus.subscribe('agent.storage.alert', handler.handleStorageAlert.bind(handler));

    /**
     * ── Payouts ──────────────────────────────────────────────────────────────
     *
     * ⚠ **These four lines are the whole defect, in the place it lived.** This consumer
     * subscribed to no `payout.*` event at all while the vendor and agency consumers each
     * subscribed to three — so an agent requested their money and heard nothing, in any
     * channel, ever. `FRONTEND-SYNC/BRIEF-payout-agent-app.md` § 2 documented it and told the
     * app team to design the earnings screen around the silence.
     *
     * ⚠ **`payout.transfer_failed` had NO subscriber on any of the three stacks.** It is
     * published by `payout-request.service.ts:580` and was consumed by nobody, which is the
     * worst of the four to miss: a *rejected* payout returns the money, while a *failed*
     * transfer leaves it held with no signal and no way for the owner to re-request.
     */
    eventBus.subscribe('payout.requested', handler.handlePayoutRequested.bind(handler));
    eventBus.subscribe('payout.paid', handler.handlePayoutPaid.bind(handler));
    eventBus.subscribe('payout.rejected', handler.handlePayoutRejected.bind(handler));
    eventBus.subscribe('payout.transfer_failed', handler.handlePayoutTransferFailed.bind(handler));

    console.log(
        `[AgentNotifications] Event handlers registered successfully (FCM push: ${isFcmConfigured() ? 'enabled' : 'disabled'})`
    );
}
