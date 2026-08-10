import { AgentNotificationRepository } from '../repositories/agent-notification.repository';
import { AgentNotificationPreferenceRepository } from '../repositories/agent-notification-preference.repository';
import { AgentRepository, IDeliveryAgent } from '../../agents';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { TelegramRepository } from '../../telegram/telegram.repository';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import { FcmPushService, ANDROID_CHANNELS, APNS_CATEGORIES } from './fcm-push.service';
import {
    AgentDeliveryChannel,
    IAgentNotification,
    AgentNotificationType,
    AgentAggregateType,
    AgentNotificationAction
} from '../models/agent-notification.model';
import { IAgentNotificationPreference } from '../models/agent-notification-preference.model';
import {
    renderAgentInApp,
    renderAgentChannelText,
    renderAgentWhatsAppTemplateParams,
    renderAgentButton,
    agentWhatsAppTemplateName,
    PLATFORM_ACTOR_LABEL,
    CONTRACT_TRANSITION_LABEL,
    CONTRACT_RESOLUTION_LABEL,
    TERMS_PROPOSAL_RESOLUTION_LABEL
} from '../catalog/agent-notification-catalog';
import type { ContractTransition, StatusRequestState, TermsProposalState } from '../../agents';
import { ChannelText } from '../catalog/notification-catalog';
import { Language, resolveLanguage, META_LANGUAGE_CODE } from '../catalog/notification-i18n';
import { RenderContext } from '../catalog/message-renderer';
import { DomainEvent } from '../../../core/events/event-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Situations that ride the dedicated offers channel (see ANDROID_CHANNELS) **and**
 * carry Accept / Decline buttons on the push.
 *
 * Only the two that are still actionable when they land. `shipment.offer.expired`
 * is deliberately absent — it reports a lost job, so waking the phone for it
 * would train agents to ignore the channel that matters, and there is nothing
 * left to accept.
 *
 * One set drives both because the predicate is the same one: *this offer can
 * still be answered*. Splitting it would let a situation get the loud channel
 * without the buttons, or the buttons without the channel.
 */
const ACTIONABLE_OFFER_SITUATIONS: ReadonlySet<AgentNotificationType> = new Set([
    'shipment.offer.received',
    'shipment.offer.reminder'
]);

interface DispatchParams {
    situation: AgentNotificationType;
    prefs: IAgentNotificationPreference;
    agentId: string;
    aggregateType: AgentAggregateType;
    aggregateId: string;
    idempotencyKey: string;
    context: RenderContext;
}

/**
 * AgentNotificationEventHandler
 *
 * Third multi-channel counterpart to VendorNotificationEventHandler — same rules
 * (mandatory in-app, always-on push, at most one preference-gated secondary
 * channel, catalog-driven localized copy). See that file's doc comment for the
 * full rule set; this handler mirrors it 1:1 for agents.
 *
 * Every situation here is the agent's own cash liability moving, which is why
 * this stack exists at all — see agent-notification.model.ts.
 */
export class AgentNotificationEventHandler {
    private notificationRepo: AgentNotificationRepository;
    private preferenceRepo: AgentNotificationPreferenceRepository;
    private agentRepo: AgentRepository;
    private agencyRepo: DeliveryAgencyRepository;
    private magazinRepo: MagazinRepository;
    private telegramRepo: TelegramRepository;
    private mailService: MailService;
    private telegramService: TelegramNotificationService;
    private whatsappWindow: WhatsappService;
    private fcmPushService: FcmPushService;

    constructor() {
        this.notificationRepo = new AgentNotificationRepository();
        this.preferenceRepo = new AgentNotificationPreferenceRepository();
        this.agentRepo = new AgentRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.magazinRepo = new MagazinRepository();
        this.telegramRepo = new TelegramRepository();
        this.mailService = new MailService();
        this.telegramService = new TelegramNotificationService();
        this.whatsappWindow = new WhatsappService();
        this.fcmPushService = new FcmPushService();
    }

    private isWhatsAppProviderConfigured(): boolean {
        return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    }

    // ─── Event handlers ──────────────────────────────────────────────────────

    /**
     * Handle cod.deposit.recorded — a deposit was confirmed and the agent's cash
     * balance fell.
     *
     * ONE event, TWO very different messages, split on `declaredAt`:
     *  - null     → the agency recorded a hand-over the agent never declared.
     *    The agent is being TOLD their money moved, and this message is the only
     *    way they will ever notice an under-recorded amount.
     *  - non-null → the receiving party answered a claim the agent had made.
     *    They already know it happened; this confirms it landed.
     */
    async handleDepositRecorded(event: DomainEvent): Promise<void> {
        try {
            const { depositId, agentId, agencyId, amount, currency, recipient, declaredAt } = event.payload;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.codDepositUpdates) return;

            const agent = await this.agentRepo.findById(agentId);
            const lang = resolveLanguage(agent);
            const agencyName = await this.resolveAgencyName(agencyId);

            const wasDeclared = !!declaredAt;
            const situation: AgentNotificationType = wasDeclared
                ? 'cod.deposit.confirmed'
                : 'cod.deposit.recorded';

            await this.dispatch({
                situation,
                prefs,
                agentId,
                aggregateType: 'deposit',
                aggregateId: depositId,
                idempotencyKey: `${situation}:${depositId}`,
                context: {
                    depositId,
                    agencyName,
                    confirmedByName: recipient === 'platform' ? PLATFORM_ACTOR_LABEL[lang] : agencyName,
                    currency,
                    amountFormatted: Number(amount).toLocaleString()
                }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle cod.deposit.recorded:', error);
        }
    }

    /**
     * Handle cod.deposit.rejected — the receiving party says the hand-over did
     * not happen, or not for that much.
     *
     * Worth telling the agent promptly for a reason beyond the dispute itself:
     * a rejection stops the declaration suppressing their late-deposit penalty,
     * so their own clock is running again from this moment.
     */
    async handleDepositRejected(event: DomainEvent): Promise<void> {
        try {
            const { depositId, agentId, agencyId, amount, currency, recipient, rejectionReason } = event.payload;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.codDepositUpdates) return;

            const agent = await this.agentRepo.findById(agentId);
            const lang = resolveLanguage(agent);
            const agencyName = await this.resolveAgencyName(agencyId);

            await this.dispatch({
                situation: 'cod.deposit.rejected',
                prefs,
                agentId,
                aggregateType: 'deposit',
                aggregateId: depositId,
                idempotencyKey: `cod.deposit.rejected:${depositId}`,
                context: {
                    depositId,
                    agencyName,
                    confirmedByName: recipient === 'platform' ? PLATFORM_ACTOR_LABEL[lang] : agencyName,
                    currency,
                    amountFormatted: Number(amount).toLocaleString(),
                    rejectionReason: rejectionReason ?? '—'
                }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle cod.deposit.rejected:', error);
        }
    }

    /**
     * Handle shipment.offer_created — a new assignment offer for this agent. The
     * agent must accept it before it times out, so push is the load-bearing
     * channel; the in-app record is the durable one.
     */
    async handleOfferReceived(event: DomainEvent): Promise<void> {
        try {
            const { offerId, agentId, agencyId, orderNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.assignmentOffers) return;

            const agencyName = await this.resolveAgencyName(agencyId);

            await this.dispatch({
                situation: 'shipment.offer.received',
                prefs,
                agentId,
                aggregateType: 'offer',
                aggregateId: offerId,
                idempotencyKey: `shipment.offer.received:${offerId}`,
                context: { offerId, agencyName, orderNumber: orderNumber ?? '—' }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle shipment.offer_created:', error);
        }
    }

    // ─── Contract handshake ──────────────────────────────────────────────────
    //
    // All three `agent_contract.*` events are published by AgentContractService
    // and consumed by BOTH this handler and the agency one; `recipientRole`
    // says which payloads are ours. Same discriminator pattern the `connection.*`
    // events use across the vendor and agency stacks.

    /** An agency asked THIS agent to contract — the request is now pending their answer. */
    async handleContractRequestReceived(event: DomainEvent): Promise<void> {
        try {
            const { contractId, recipientRole, agentId, agencyName } = event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            await this.dispatch({
                situation: 'agent_contract.request_received',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                idempotencyKey: `agent_contract.request_received:${contractId}:agent`,
                context: { contractId, agencyName }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle agent_contract.request_received:', error);
        }
    }

    /** An agency approved this agent's application. */
    async handleContractApproved(event: DomainEvent): Promise<void> {
        try {
            const { contractId, recipientRole, agentId, agencyName } = event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            await this.dispatch({
                situation: 'agent_contract.approved',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                idempotencyKey: `agent_contract.approved:${contractId}:agent:${event.occurredAt.toISOString()}`,
                context: { contractId, agencyName }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle agent_contract.approved:', error);
        }
    }

    /** An agency declined this agent's application. */
    async handleContractRejected(event: DomainEvent): Promise<void> {
        try {
            const { contractId, recipientRole, agentId, agencyName } = event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            await this.dispatch({
                situation: 'agent_contract.rejected',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                idempotencyKey: `agent_contract.rejected:${contractId}:agent:${event.occurredAt.toISOString()}`,
                context: { contractId, agencyName }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle agent_contract.rejected:', error);
        }
    }

    // ─── Contract status requests ────────────────────────────────────────────
    //
    // Changes to a contract that already exists, as opposed to the handshake
    // that forms one. Same `recipientRole` discriminator and the same
    // `contractUpdated` gate; what differs is that the transition is a parameter,
    // so the copy takes a LOCALIZED label rather than the raw enum — resolving
    // it needs the agent's language, which is why it is read before dispatch.

    /** An agency proposed a change to this agent's contract; it awaits their answer. */
    async handleContractStatusRequestRaised(event: DomainEvent): Promise<void> {
        try {
            const { contractId, requestId, recipientRole, agentId, agencyName, transition } =
                event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            const lang = await this.resolveAgentLanguage(agentId);

            await this.dispatch({
                situation: 'agent_contract.status_request_raised',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                // Keyed on the REQUEST, not the contract: a contract may be
                // paused, reactivated and later terminated, and each proposal is
                // its own thing to answer.
                idempotencyKey: `agent_contract.status_request_raised:${requestId}`,
                context: {
                    contractId,
                    agencyName,
                    transitionLabel: CONTRACT_TRANSITION_LABEL[transition as ContractTransition][lang]
                }
            });
        } catch (error) {
            console.error(
                '[AgentNotificationHandler] Failed to handle agent_contract.status_request_raised:',
                error
            );
        }
    }

    /** A request this agent raised was approved, declined, or cancelled by them. */
    async handleContractStatusRequestResolved(event: DomainEvent): Promise<void> {
        try {
            const { contractId, requestId, recipientRole, agentId, agencyName, transition, state } =
                event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            const lang = await this.resolveAgentLanguage(agentId);

            await this.dispatch({
                situation: 'agent_contract.status_request_resolved',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                // A request resolves exactly once — the repository's
                // compare-and-set on `state: 'pending'` guarantees it — so the
                // request id alone is a sufficient key.
                idempotencyKey: `agent_contract.status_request_resolved:${requestId}`,
                context: {
                    contractId,
                    agencyName,
                    transitionLabel: CONTRACT_TRANSITION_LABEL[transition as ContractTransition][lang],
                    resolutionLabel: CONTRACT_RESOLUTION_LABEL[state as StatusRequestState][lang]
                }
            });
        } catch (error) {
            console.error(
                '[AgentNotificationHandler] Failed to handle agent_contract.status_request_resolved:',
                error
            );
        }
    }

    // ─── Terms negotiation ───────────────────────────────────────────────────
    //
    // Same `recipientRole` discriminator and `contractUpdated` gate as above.
    // What differs is WHAT is being changed: these carry the terms of the
    // bargain rather than its status, and `terms_proposed` in particular must
    // land with the fact that nothing has changed yet.

    /** The agency countered the terms on a pending contract; the agent answers. */
    async handleContractTermsCountered(event: DomainEvent): Promise<void> {
        try {
            const { contractId, recipientRole, agentId, agencyName } = event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            await this.dispatch({
                situation: 'agent_contract.terms_countered',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                // Keyed on the emission time, not the contract: a negotiation is
                // a sequence of counters on ONE contract, and keying on the
                // contract alone would suppress every counter after the first.
                idempotencyKey: `agent_contract.terms_countered:${contractId}:${event.occurredAt.toISOString()}`,
                context: { contractId, agencyName }
            });
        } catch (error) {
            console.error(
                '[AgentNotificationHandler] Failed to handle agent_contract.terms_countered:',
                error
            );
        }
    }

    /** A change proposed to a LIVE contract, awaiting this agent's answer. */
    async handleContractTermsProposed(event: DomainEvent): Promise<void> {
        try {
            const { contractId, proposalId, recipientRole, agentId, agencyName } = event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            await this.dispatch({
                situation: 'agent_contract.terms_proposed',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                // One proposal is raised once, so its id is a sufficient key.
                idempotencyKey: `agent_contract.terms_proposed:${proposalId}`,
                context: { contractId, agencyName }
            });
        } catch (error) {
            console.error(
                '[AgentNotificationHandler] Failed to handle agent_contract.terms_proposed:',
                error
            );
        }
    }

    /** A proposal was accepted, declined, withdrawn or superseded. */
    async handleContractTermsResolved(event: DomainEvent): Promise<void> {
        try {
            const { contractId, proposalId, recipientRole, agentId, agencyName, state } =
                event.payload;
            if (recipientRole !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.contractUpdated) return;

            const lang = await this.resolveAgentLanguage(agentId);

            await this.dispatch({
                situation: 'agent_contract.terms_resolved',
                prefs,
                agentId,
                aggregateType: 'contract',
                aggregateId: contractId,
                // A proposal resolves exactly once — the repository's
                // compare-and-set on `state: 'pending'` guarantees it.
                idempotencyKey: `agent_contract.terms_resolved:${proposalId}`,
                context: {
                    contractId,
                    agencyName,
                    resolutionLabel:
                        TERMS_PROPOSAL_RESOLUTION_LABEL[state as TermsProposalState][lang]
                }
            });
        } catch (error) {
            console.error(
                '[AgentNotificationHandler] Failed to handle agent_contract.terms_resolved:',
                error
            );
        }
    }

    /**
     * Handle shipment.reassigned — the agent was taken off a shipment and it was
     * handed to another agent. Tell the PREVIOUS agent they are no longer
     * responsible for it (their live access is already revoked by the detach).
     * Gated on the same `assignmentOffers` preference as the offer notifications.
     */
    async handleReassignedAway(event: DomainEvent): Promise<void> {
        try {
            const { shipmentId, previousAgentId, agencyId, orderNumber } = event.payload;
            if (!previousAgentId) return;

            const prefs = await this.preferenceRepo.getByAgent(previousAgentId);
            if (!prefs.preferences.assignmentOffers) return;

            const agencyName = await this.resolveAgencyName(agencyId);

            await this.dispatch({
                situation: 'shipment.reassigned_away',
                prefs,
                agentId: previousAgentId,
                aggregateType: 'shipment',
                aggregateId: shipmentId,
                idempotencyKey: `shipment.reassigned_away:${shipmentId}:${previousAgentId}`,
                context: { orderNumber: orderNumber ?? '—', agencyName }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle shipment.reassigned:', error);
        }
    }

    /**
     * Handle shipment.offer_reminder — auto-assignment's round-2 nudge that a
     * still-open offer is waiting. Same preference gate + deep link as the
     * original offer; idempotent PER ROUND so each round produces one reminder.
     */
    async handleOfferReminder(event: DomainEvent): Promise<void> {
        try {
            const { offerId, agentId, agencyId, orderNumber, round } = event.payload;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.assignmentOffers) return;

            const agencyName = await this.resolveAgencyName(agencyId);

            await this.dispatch({
                situation: 'shipment.offer.reminder',
                prefs,
                agentId,
                aggregateType: 'offer',
                aggregateId: offerId,
                idempotencyKey: `shipment.offer.reminder:${offerId}:${round ?? 2}`,
                context: { offerId, agencyName, orderNumber: orderNumber ?? '—' }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle shipment.offer_reminder:', error);
        }
    }

    /** Handle shipment.offer_expired — an offer the agent didn't answer lapsed. */
    async handleOfferExpired(event: DomainEvent): Promise<void> {
        try {
            const { offerId, agentId, agencyId, orderNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByAgent(agentId);
            if (!prefs.preferences.assignmentOffers) return;

            const agencyName = await this.resolveAgencyName(agencyId);

            await this.dispatch({
                situation: 'shipment.offer.expired',
                prefs,
                agentId,
                aggregateType: 'offer',
                aggregateId: offerId,
                idempotencyKey: `shipment.offer.expired:${offerId}`,
                context: { offerId, agencyName, orderNumber: orderNumber ?? '—' }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle shipment.offer_expired:', error);
        }
    }

    /**
     * Handle plan.expiring — this agent's subscription plan crosses into its
     * notice window. Owner-typed event shared across roles; only the agent case
     * is ours. Idempotent on the plan's expiry date.
     */
    async handlePlanExpiring(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, planCode, expiresAt, daysUntilExpiry } = event.payload;
            if (ownerType !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(ownerId);
            if (prefs.preferences.planUpdates === false) return; // opted out (default on)

            await this.dispatch({
                situation: 'plan.expiring',
                prefs,
                agentId: ownerId,
                aggregateType: 'plan',
                aggregateId: ownerId,
                idempotencyKey: `plan.expiring:${ownerId}:${new Date(expiresAt).toISOString()}`,
                context: {
                    planCode,
                    daysUntilExpiry,
                    expiresDate: new Date(expiresAt).toLocaleDateString()
                }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle plan.expiring:', error);
        }
    }

    /**
     * Handle plan.expired — this agent's plan lapsed (handed over or downgraded).
     * A downgrade lowers their concurrent-delivery cap, which the copy calls out.
     */
    async handlePlanExpired(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, expiredPlanCode, newPlanCode } = event.payload;
            if (ownerType !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(ownerId);
            if (prefs.preferences.planUpdates === false) return;

            await this.dispatch({
                situation: 'plan.expired',
                prefs,
                agentId: ownerId,
                aggregateType: 'plan',
                aggregateId: ownerId,
                idempotencyKey: `plan.expired:${ownerId}:${expiredPlanCode}:${event.occurredAt.toISOString().slice(0, 10)}`,
                context: { expiredPlanCode, newPlanCode }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle plan.expired:', error);
        }
    }

    /**
     * Handle agent.storage.alert — this agent's OWN media storage crossed a usage
     * threshold (80/90/100%). Fired by the file-cleanup sweep; the idempotency key
     * (agent + threshold + month) bounds re-alerts to once per month per band.
     * (Delivery proofs are charged to the agency, not counted here.)
     */
    async handleStorageAlert(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, usageBytes, limitBytes, percentUsed, threshold, idempotencyKey } = event.payload;
            if (ownerType !== 'agent') return;

            const prefs = await this.preferenceRepo.getByAgent(ownerId);
            if (prefs.preferences.storageAlert === false) return; // opted out (default on)

            await this.dispatch({
                situation: 'storage.alert',
                prefs,
                agentId: ownerId,
                aggregateType: 'storage',
                aggregateId: ownerId,
                idempotencyKey: idempotencyKey ?? `agent.storage.alert:${ownerId}:${threshold}`,
                context: {
                    percentUsed,
                    usageFormatted: this.formatBytes(usageBytes),
                    limitFormatted: this.formatBytes(limitBytes),
                    threshold
                }
            });
        } catch (error) {
            console.error('[AgentNotificationHandler] Failed to handle agent.storage.alert:', error);
        }
    }

    /** Human-readable byte size (B/KB/MB/GB). */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /**
     * The agency's display name, or a neutral fallback. Never throws: a missing
     * agency must not cost the agent the notification — the amount is the part
     * that matters, and it is right there in the message.
     */
    private async resolveAgencyName(agencyId: string): Promise<string> {
        try {
            // Business name lives on the Magazin (source of truth).
            return (await this.magazinRepo.findNameByAgencyId(agencyId)) ?? 'your agency';
        } catch {
            return 'your agency';
        }
    }

    /**
     * The agent's language, for copy a handler has to localize BEFORE handing it
     * to `dispatch` — which resolves the language again for the template itself.
     * The double read is deliberate: a caller-substituted label has to be in the
     * same language the template will be rendered in, and `resolveLanguage`
     * falling back to the default keeps the two consistent even when the agent
     * cannot be loaded.
     */
    private async resolveAgentLanguage(agentId: string): Promise<Language> {
        return resolveLanguage(await this.agentRepo.findById(agentId));
    }

    // ─── Dispatch + delivery ─────────────────────────────────────────────────

    private async dispatch(params: DispatchParams): Promise<void> {
        const agent = await this.agentRepo.findById(params.agentId);
        const lang = resolveLanguage(agent);

        const deliveredVia: AgentDeliveryChannel[] = agent
            ? await this.determineDeliveryChannels(agent, params.prefs)
            : ['in-app'];

        const inApp = renderAgentInApp(params.situation, lang, params.context);
        const action = this.resolveAction(params.situation, lang, params.context);

        const notification = await this.notificationRepo.createIfNotExists({
            agentId: params.agentId,
            type: params.situation,
            title: inApp.title,
            message: inApp.message,
            aggregateType: params.aggregateType,
            aggregateId: params.aggregateId,
            action: action ?? undefined,
            deliveredVia,
            idempotencyKey: params.idempotencyKey
        });

        if (agent) {
            await this.deliverPush(notification, params.situation, inApp, action, agent);
            await this.deliverToSecondaryChannels(notification, deliveredVia, params.situation, lang, agent, params.context);
        }
    }

    private async deliverPush(
        notification: IAgentNotification,
        situation: AgentNotificationType,
        inApp: { title: string; message: string },
        action: AgentNotificationAction | null,
        agent: IDeliveryAgent
    ): Promise<void> {
        // An offer the agent can still answer gets Accept / Decline on the push
        // itself. That costs a data-only message on Android (the app has to draw
        // the notification to own the buttons) and an APNs category on iOS. Every
        // other situation — including `shipment.offer.expired` — keeps the plain
        // OS-drawn notification, which survives a killed app more reliably.
        //
        // The buttons wake the app rather than answering in the background:
        // accepting fails often and for reasons the agent has to read
        // (SHIPMENT_ALREADY_HAS_AGENT, AGENT_AT_CAPACITY,
        // CONTRACT_SHIPMENT_VALUE_EXCEEDED), and a silent POST has nowhere to
        // report them. No endpoint changes — the app calls the ordinary
        // POST /api/agent/offers/:id/{accept,reject} with the agent's own token,
        // parsing the offer id out of `data.path` (`offers/{offerId}`).
        const actionable = ACTIONABLE_OFFER_SITUATIONS.has(situation);

        try {
            const targeted = await this.fcmPushService.sendToUser(agent.user_id.toString(), {
                title: inApp.title,
                body: inApp.message,
                channelId: actionable
                    ? ANDROID_CHANNELS.AGENT_OFFERS
                    : ANDROID_CHANNELS.DEFAULT,
                dataOnly: actionable,
                category: actionable ? APNS_CATEGORIES.AGENT_OFFER : undefined,
                data: {
                    type: situation,
                    aggregateType: notification.aggregateType,
                    aggregateId: notification.aggregateId.toString(),
                    path: action?.path,
                    url: action?.url
                }
            });

            if (targeted > 0) {
                await this.notificationRepo.addDeliveredChannel(notification._id as any, 'push');
            }
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error('[AgentNotificationHandler] push delivery failed:', message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, 'push', message);
            } catch (recordErr) {
                console.error('[AgentNotificationHandler] Failed to record push delivery error:', recordErr);
            }
        }
    }

    /**
     * Determine delivery channels based on preferences and live verification.
     * Same rules as AgencyNotificationEventHandler.determineDeliveryChannels.
     */
    private async determineDeliveryChannels(
        agent: IDeliveryAgent,
        prefs: IAgentNotificationPreference
    ): Promise<AgentDeliveryChannel[]> {
        const channels: AgentDeliveryChannel[] = ['in-app'];

        if (prefs.telegramEnabled) {
            const telegramLink = await this.telegramRepo.findByUserId(agent.user_id.toString());
            if (telegramLink && telegramLink.isActive) {
                channels.push('telegram');
                return channels;
            }
        }

        if (prefs.emailEnabled && agent.email_verified) {
            channels.push('email');
            return channels;
        }

        if (prefs.whatsappEnabled && agent.wa?.verified) {
            channels.push('whatsapp');
            return channels;
        }

        return channels;
    }

    private async deliverToSecondaryChannels(
        notification: IAgentNotification,
        channels: AgentDeliveryChannel[],
        situation: AgentNotificationType,
        lang: Language,
        agent: IDeliveryAgent,
        context: RenderContext
    ): Promise<void> {
        const button = this.resolveButton(situation, lang, context);

        if (channels.includes('telegram')) {
            const content = renderAgentChannelText(situation, 'telegram', lang, context);
            await this.attemptDelivery(notification, 'telegram', () =>
                this.sendTelegram(agent, content, button)
            );
        }

        if (channels.includes('email')) {
            const content = renderAgentChannelText(situation, 'email', lang, context);
            await this.attemptDelivery(notification, 'email', () =>
                this.sendEmail(agent, content, button, context)
            );
        }

        if (channels.includes('whatsapp')) {
            await this.attemptDelivery(notification, 'whatsapp', () =>
                this.sendWhatsApp(agent, notification, situation, lang, context)
            );
        }
    }

    private resolveButton(
        situation: AgentNotificationType,
        lang: Language,
        context: RenderContext
    ): { label: string; url: string } | null {
        const baseUrl = process.env.AGENT_APP_URL;
        if (!baseUrl) return null;

        const button = renderAgentButton(situation, lang, context, baseUrl);
        return button ? { label: button.label, url: button.url } : null;
    }

    private resolveAction(
        situation: AgentNotificationType,
        lang: Language,
        context: RenderContext
    ): AgentNotificationAction | null {
        const baseUrl = process.env.AGENT_APP_URL;
        const button = renderAgentButton(situation, lang, context, baseUrl);
        if (!button) return null;

        return {
            label: button.label,
            path: button.urlSuffix,
            url: baseUrl ? button.url : undefined
        };
    }

    private async attemptDelivery(
        notification: IAgentNotification,
        channel: AgentDeliveryChannel,
        send: () => Promise<void>
    ): Promise<void> {
        try {
            await send();
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error(`[AgentNotificationHandler] ${channel} delivery failed:`, message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, channel, message);
            } catch (recordErr) {
                console.error('[AgentNotificationHandler] Failed to record delivery error:', recordErr);
            }
        }
    }

    /** Send a preformatted email notification with an optional CTA button. */
    private async sendEmail(
        agent: IDeliveryAgent,
        content: ChannelText,
        button: { label: string; url: string } | null,
        context: RenderContext
    ): Promise<void> {
        if (!agent.email_verified || !agent.email) return;

        await this.mailService.send({
            to: agent.email,
            subject: content.subject,
            template: 'agent-notification',
            type: 'SYSTEM',
            variables: {
                agentName: agent.name,
                title: content.subject,
                message: content.body,
                actionLabel: button?.label ?? null,
                actionUrl: button?.url ?? null,
                ...context
            }
        });
    }

    /** Send a preformatted Telegram notification with an optional inline URL button. */
    private async sendTelegram(
        agent: IDeliveryAgent,
        content: ChannelText,
        button: { label: string; url: string } | null
    ): Promise<void> {
        const message = `*${content.subject}*\n\n${content.body}`;

        const result = await this.telegramService.send({
            userId: agent.user_id.toString(),
            message,
            button: button ?? undefined
        });

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.DELIVERY_AGENT_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error || 'Telegram delivery failed'
            );
        }
    }

    /**
     * Send a WhatsApp notification in the agent's language. Same
     * inside-window/outside-window logic as AgencyNotificationEventHandler.sendWhatsApp.
     */
    private async sendWhatsApp(
        agent: IDeliveryAgent,
        notification: IAgentNotification,
        situation: AgentNotificationType,
        lang: Language,
        context: RenderContext
    ): Promise<void> {
        if (!this.isWhatsAppProviderConfigured()) {
            console.log('[AgentNotificationHandler] WhatsApp not configured; skipping delivery');
            return;
        }

        if (!agent.wa?.verified || !agent.wa.wa_phone_id) return;

        const waPhoneId = agent.wa.wa_phone_id;
        const to = waPhoneId.startsWith('+') ? waPhoneId : `+${waPhoneId}`;

        const withinWindow = await this.whatsappWindow.canSendFreeMessage(waPhoneId);

        let result;
        if (withinWindow) {
            const content = renderAgentChannelText(situation, 'whatsapp', lang, context);
            const button = process.env.AGENT_APP_URL
                ? renderAgentButton(situation, lang, context, process.env.AGENT_APP_URL)
                : null;

            if (button) {
                result = await getWhatsAppMessagingService().send(
                    WaServiceMessage.ctaUrl({
                        to,
                        header: content.subject,
                        body: content.body,
                        displayText: button.label,
                        url: button.url
                    })
                );
            } else {
                result = await getWhatsAppMessagingService().send(
                    WaServiceMessage.text({ to, body: `${content.subject}\n\n${content.body}` })
                );
            }
        } else {
            const components: TemplateComponent[] = [
                {
                    type: 'body',
                    parameters: renderAgentWhatsAppTemplateParams(situation, lang, context).map(text => ({
                        type: 'text' as const,
                        text
                    }))
                }
            ];

            const button = renderAgentButton(situation, lang, context, process.env.AGENT_APP_URL);
            if (button) {
                components.push({
                    type: 'button',
                    sub_type: 'url',
                    index: 0,
                    parameters: [{ type: 'text', text: button.urlSuffix }]
                });
            }

            result = await getWhatsAppMessagingService().send({
                to,
                type: 'template',
                message: {
                    type: 'template',
                    name: agentWhatsAppTemplateName(situation),
                    language: META_LANGUAGE_CODE[lang],
                    components
                },
                meta: {
                    idempotencyKey: `notif:${notification.idempotencyKey}:whatsapp`
                }
            });
        }

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.DELIVERY_AGENT_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error?.message || 'WhatsApp delivery failed'
            );
        }
    }
}
