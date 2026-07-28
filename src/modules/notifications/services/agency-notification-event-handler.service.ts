import { AgencyNotificationRepository } from '../repositories/agency-notification.repository';
import { AgencyNotificationPreferenceRepository } from '../repositories/agency-notification-preference.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { IDeliveryAgency } from '../../delivery/delivery-agency.model';
import { AgentRepository } from '../../agents';
import { COD_CONFIG } from '../../cod/config/cod.config';
import { TelegramRepository } from '../../telegram/telegram.repository';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import { FcmPushService } from './fcm-push.service';
import {
    AgencyDeliveryChannel,
    IAgencyNotification,
    AgencyNotificationType,
    AgencyAggregateType,
    AgencyNotificationAction
} from '../models/agency-notification.model';
import { IAgencyNotificationPreference } from '../models/agency-notification-preference.model';
import {
    renderAgencyInApp,
    renderAgencyChannelText,
    renderAgencyWhatsAppTemplateParams,
    renderAgencyButton,
    agencyWhatsAppTemplateName
} from '../catalog/agency-notification-catalog';
import { ChannelText } from '../catalog/notification-catalog';
import { Language, resolveLanguage, META_LANGUAGE_CODE } from '../catalog/notification-i18n';
import { RenderContext } from '../catalog/message-renderer';
import { DomainEvent } from '../../../core/events/event-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

interface DispatchParams {
    situation: AgencyNotificationType;
    prefs: IAgencyNotificationPreference;
    agencyId: string;
    aggregateType: AgencyAggregateType;
    aggregateId: string;
    idempotencyKey: string;
    context: RenderContext;
}

/**
 * AgencyNotificationEventHandler
 *
 * Multi-channel counterpart to VendorNotificationEventHandler — same rules
 * (mandatory in-app, always-on push, at most one preference-gated secondary
 * channel, catalog-driven localized copy). See that file's doc comment for
 * the full rule set; this handler mirrors it 1:1 for agencies.
 */
export class AgencyNotificationEventHandler {
    private notificationRepo: AgencyNotificationRepository;
    private preferenceRepo: AgencyNotificationPreferenceRepository;
    private agencyRepo: DeliveryAgencyRepository;
    private magazinRepo: MagazinRepository;
    private agentRepo: AgentRepository;
    private telegramRepo: TelegramRepository;
    private mailService: MailService;
    private telegramService: TelegramNotificationService;
    private whatsappWindow: WhatsappService;
    private fcmPushService: FcmPushService;

    constructor() {
        this.notificationRepo = new AgencyNotificationRepository();
        this.preferenceRepo = new AgencyNotificationPreferenceRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.magazinRepo = new MagazinRepository();
        this.agentRepo = new AgentRepository();
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

    /** Handle connection.request_received event (a vendor sent this agency a request). */
    async handleConnectionRequestReceived(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, agencyId, vendorName } = event.payload;
            if (recipientRole !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.request_received',
                prefs,
                agencyId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.request_received:${connectionId}:agency`,
                context: { vendorName, connectionId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle connection.request_received:', error);
        }
    }

    /** Handle connection.approved event (the vendor approved/reapproved a request this agency sent). */
    async handleConnectionApproved(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, agencyId, vendorName } = event.payload;
            if (recipientRole !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.approved',
                prefs,
                agencyId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.approved:${connectionId}:agency:${event.occurredAt.toISOString()}`,
                context: { vendorName, connectionId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle connection.approved:', error);
        }
    }

    /** Handle connection.rejected event (the vendor rejected a request this agency sent). */
    async handleConnectionRejected(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, agencyId, vendorName } = event.payload;
            if (recipientRole !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.rejected',
                prefs,
                agencyId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.rejected:${connectionId}:agency:${event.occurredAt.toISOString()}`,
                context: { vendorName, connectionId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle connection.rejected:', error);
        }
    }

    /** Handle connection.reapproval_needed event (the vendor changed its policies; this agency must reapprove). */
    async handleConnectionReapprovalNeeded(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, agencyId, vendorName } = event.payload;
            if (recipientRole !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.reapproval_needed',
                prefs,
                agencyId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.reapproval_needed:${connectionId}:agency:${event.occurredAt.toISOString()}`,
                context: { vendorName, connectionId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle connection.reapproval_needed:', error);
        }
    }

    /** Handle shipment.assigned event (a vendor dispatched an order to this agency). */
    async handleShipmentAssigned(event: DomainEvent): Promise<void> {
        try {
            const { shipmentId, agencyId, orderNumber, itemCount } = event.payload;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.shipmentAssigned) return;

            await this.dispatch({
                situation: 'shipment.assigned',
                prefs,
                agencyId,
                aggregateType: 'shipment',
                aggregateId: shipmentId,
                idempotencyKey: `shipment.assigned:${shipmentId}`,
                context: { orderNumber, itemCount, shipmentId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle shipment.assigned:', error);
        }
    }

    /** Handle shipment.offer_accepted — an agent took a shipment this agency offered. */
    async handleOfferAccepted(event: DomainEvent): Promise<void> {
        try {
            const { shipmentId, agencyId, orderNumber, agentName } = event.payload;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.shipmentAssigned) return;

            await this.dispatch({
                situation: 'shipment.offer.accepted',
                prefs,
                agencyId,
                aggregateType: 'shipment',
                aggregateId: shipmentId,
                idempotencyKey: `shipment.offer.accepted:${shipmentId}`,
                context: { shipmentId, orderNumber: orderNumber ?? '—', agentName: agentName ?? 'The agent' }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle shipment.offer_accepted:', error);
        }
    }

    /**
     * Handle shipment.no_agent_available — nobody accepted (declined, timed out,
     * or the auto pool was exhausted). Tells the agency to assign manually. The
     * idempotency key carries the event time so a shipment that goes unfilled
     * again after a manual retry still notifies rather than being deduped away.
     */
    async handleAssignmentUnfilled(event: DomainEvent): Promise<void> {
        try {
            const { shipmentId, agencyId, orderNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.shipmentAssigned) return;

            const at = new Date(event.occurredAt ?? Date.now()).getTime();
            await this.dispatch({
                situation: 'shipment.assignment.unfilled',
                prefs,
                agencyId,
                aggregateType: 'shipment',
                aggregateId: shipmentId,
                idempotencyKey: `shipment.assignment.unfilled:${shipmentId}:${at}`,
                context: { shipmentId, orderNumber: orderNumber ?? '—' }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle shipment.no_agent_available:', error);
        }
    }

    /** Handle payout.requested event (fires for both vendor and agency payouts). */
    async handlePayoutRequested(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.requested',
                prefs,
                agencyId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.requested:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle payout.requested:', error);
        }
    }

    /** Handle payout.paid event (fires for both vendor and agency payouts). */
    async handlePayoutPaid(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.paid',
                prefs,
                agencyId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.paid:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle payout.paid:', error);
        }
    }

    /** Handle payout.rejected event (fires for both vendor and agency payouts). */
    async handlePayoutRejected(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.rejected',
                prefs,
                agencyId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.rejected:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle payout.rejected:', error);
        }
    }

    /**
     * Handle cod.deposit.declared — one of this agency's agents says they handed
     * cash over, and the agency now has DEPOSIT_CONFIRM_DEADLINE_DAYS to confirm
     * or reject it before a `deposit_not_confirmed` flag freezes their reserve
     * releases.
     *
     * Only the 'agency' recipient: a platform-bound declaration is the admin's to
     * answer, and telling the agency to review something they cannot act on would
     * be worse than saying nothing.
     */
    async handleCodDepositDeclared(event: DomainEvent): Promise<void> {
        try {
            const { depositId, agencyId, agentId, amount, currency, recipient } = event.payload;
            if (recipient !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.codDepositUpdates) return;

            await this.dispatch({
                situation: 'cod.deposit.declared',
                prefs,
                agencyId,
                aggregateType: 'deposit',
                aggregateId: depositId,
                idempotencyKey: `cod.deposit.declared:${depositId}`,
                context: {
                    depositId,
                    agentName: await this.resolveAgentName(agentId),
                    currency,
                    amountFormatted: Number(amount).toLocaleString(),
                    deadlineDays: COD_CONFIG.DEPOSIT_CONFIRM_DEADLINE_DAYS
                }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle cod.deposit.declared:', error);
        }
    }

    /**
     * Handle cod.deposit.recorded — but ONLY the direct-to-platform case.
     *
     * The agency route is the agency's own action, so telling them about it would
     * be pure echo. A platform payment is different: the agency's liability fell
     * and its collections settled without it doing anything, so silence would
     * look like its books had drifted.
     *
     * This event is shared with the agent consumer, which handles the rest — the
     * same pattern the connection.* events already use.
     */
    async handleCodDepositRecorded(event: DomainEvent): Promise<void> {
        try {
            const { depositId, agencyId, agentId, amount, currency, recipient } = event.payload;
            if (recipient !== 'platform') return;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (!prefs.preferences.codDepositUpdates) return;

            await this.dispatch({
                situation: 'cod.deposit.direct_to_platform',
                prefs,
                agencyId,
                aggregateType: 'deposit',
                aggregateId: depositId,
                idempotencyKey: `cod.deposit.direct_to_platform:${depositId}`,
                context: {
                    depositId,
                    agentName: await this.resolveAgentName(agentId),
                    currency,
                    amountFormatted: Number(amount).toLocaleString()
                }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle cod.deposit.recorded:', error);
        }
    }

    /**
     * Handle plan.expiring — this agency's subscription plan crosses into its
     * notice window. Owner-typed event shared across roles; only the agency case
     * is ours. Idempotent on the plan's expiry date.
     */
    async handlePlanExpiring(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, planCode, expiresAt, daysUntilExpiry } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (prefs.preferences.planUpdates === false) return; // opted out (default on)

            await this.dispatch({
                situation: 'plan.expiring',
                prefs,
                agencyId: ownerId,
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
            console.error('[AgencyNotificationHandler] Failed to handle plan.expiring:', error);
        }
    }

    /** Handle plan.expired — this agency's plan lapsed (handed over or downgraded). */
    async handlePlanExpired(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, expiredPlanCode, newPlanCode } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (prefs.preferences.planUpdates === false) return;

            await this.dispatch({
                situation: 'plan.expired',
                prefs,
                agencyId: ownerId,
                aggregateType: 'plan',
                aggregateId: ownerId,
                idempotencyKey: `plan.expired:${ownerId}:${expiredPlanCode}:${event.occurredAt.toISOString().slice(0, 10)}`,
                context: { expiredPlanCode, newPlanCode }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle plan.expired:', error);
        }
    }

    /**
     * Handle agency.shipment_cap.exceeded — this agency is at/over its plan's
     * unterminated-shipment SOFT cap. Deliveries are never blocked; this is a
     * monitoring nudge. The cap sweep already debounces (once per crossing), and
     * the idempotency key dedups a same-day re-alert.
     */
    async handleShipmentCapExceeded(event: DomainEvent): Promise<void> {
        try {
            const { agencyId, planCode, cap, current } = event.payload;

            const prefs = await this.preferenceRepo.getByAgency(agencyId);
            if (prefs.preferences.planUpdates === false) return;

            await this.dispatch({
                situation: 'shipment.cap.exceeded',
                prefs,
                agencyId,
                aggregateType: 'plan',
                aggregateId: agencyId,
                idempotencyKey: `shipment.cap.exceeded:${agencyId}:${event.occurredAt.toISOString().slice(0, 10)}`,
                context: { planCode, cap, current }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle agency.shipment_cap.exceeded:', error);
        }
    }

    /**
     * Handle agency.storage.alert — this agency's media storage crossed a usage
     * threshold (80/90/100%). Fired by the file-cleanup sweep; the idempotency key
     * (agency + threshold + month) bounds re-alerts to once per month per band.
     */
    async handleStorageAlert(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, usageBytes, limitBytes, percentUsed, threshold, idempotencyKey } = event.payload;
            if (ownerType !== 'agency') return;

            const prefs = await this.preferenceRepo.getByAgency(ownerId);
            if (prefs.preferences.storageAlert === false) return; // opted out (default on)

            await this.dispatch({
                situation: 'storage.alert',
                prefs,
                agencyId: ownerId,
                aggregateType: 'storage',
                aggregateId: ownerId,
                idempotencyKey: idempotencyKey ?? `agency.storage.alert:${ownerId}:${threshold}`,
                context: {
                    percentUsed,
                    usageFormatted: this.formatBytes(usageBytes),
                    limitFormatted: this.formatBytes(limitBytes),
                    threshold
                }
            });
        } catch (error) {
            console.error('[AgencyNotificationHandler] Failed to handle agency.storage.alert:', error);
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
     * The agent's display name, or a neutral fallback. Never throws: a missing
     * agent must not cost the agency a notification about real money.
     */
    private async resolveAgentName(agentId: string): Promise<string> {
        try {
            const agent = await this.agentRepo.findById(agentId);
            return agent?.name ?? 'An agent';
        } catch {
            return 'An agent';
        }
    }

    // ─── Dispatch + delivery ─────────────────────────────────────────────────

    private async dispatch(params: DispatchParams): Promise<void> {
        const agency = await this.agencyRepo.findById(params.agencyId);
        const lang = resolveLanguage(agency);

        const deliveredVia: AgencyDeliveryChannel[] = agency
            ? await this.determineDeliveryChannels(agency, params.prefs)
            : ['in-app'];

        const inApp = renderAgencyInApp(params.situation, lang, params.context);
        const action = this.resolveAction(params.situation, lang, params.context);

        const notification = await this.notificationRepo.createIfNotExists({
            agencyId: params.agencyId,
            type: params.situation,
            title: inApp.title,
            message: inApp.message,
            aggregateType: params.aggregateType,
            aggregateId: params.aggregateId,
            action: action ?? undefined,
            deliveredVia,
            idempotencyKey: params.idempotencyKey
        });

        if (agency) {
            await this.deliverPush(notification, params.situation, inApp, action, agency);
            await this.deliverToSecondaryChannels(notification, deliveredVia, params.situation, lang, agency, params.context);
        }
    }

    private async deliverPush(
        notification: IAgencyNotification,
        situation: AgencyNotificationType,
        inApp: { title: string; message: string },
        action: AgencyNotificationAction | null,
        agency: IDeliveryAgency
    ): Promise<void> {
        try {
            const targeted = await this.fcmPushService.sendToUser(agency.user_id.toString(), {
                title: inApp.title,
                body: inApp.message,
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
            console.error('[AgencyNotificationHandler] push delivery failed:', message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, 'push', message);
            } catch (recordErr) {
                console.error('[AgencyNotificationHandler] Failed to record push delivery error:', recordErr);
            }
        }
    }

    /**
     * Determine delivery channels based on preferences and live verification.
     * Same rules as VendorNotificationEventHandler.determineDeliveryChannels.
     */
    private async determineDeliveryChannels(
        agency: IDeliveryAgency,
        prefs: IAgencyNotificationPreference
    ): Promise<AgencyDeliveryChannel[]> {
        const channels: AgencyDeliveryChannel[] = ['in-app'];

        if (prefs.telegramEnabled) {
            const telegramLink = await this.telegramRepo.findByUserId(agency.user_id.toString());
            if (telegramLink && telegramLink.isActive) {
                channels.push('telegram');
                return channels;
            }
        }

        if (prefs.emailEnabled && agency.email_verified) {
            channels.push('email');
            return channels;
        }

        if (prefs.whatsappEnabled && agency.wa?.verified) {
            channels.push('whatsapp');
            return channels;
        }

        return channels;
    }

    private async deliverToSecondaryChannels(
        notification: IAgencyNotification,
        channels: AgencyDeliveryChannel[],
        situation: AgencyNotificationType,
        lang: Language,
        agency: IDeliveryAgency,
        context: RenderContext
    ): Promise<void> {
        const button = this.resolveButton(situation, lang, context);

        if (channels.includes('telegram')) {
            const content = renderAgencyChannelText(situation, 'telegram', lang, context);
            await this.attemptDelivery(notification, 'telegram', () =>
                this.sendTelegram(agency, content, button)
            );
        }

        if (channels.includes('email')) {
            const content = renderAgencyChannelText(situation, 'email', lang, context);
            await this.attemptDelivery(notification, 'email', () =>
                this.sendEmail(agency, content, button, context)
            );
        }

        if (channels.includes('whatsapp')) {
            await this.attemptDelivery(notification, 'whatsapp', () =>
                this.sendWhatsApp(agency, notification, situation, lang, context)
            );
        }
    }

    private resolveButton(
        situation: AgencyNotificationType,
        lang: Language,
        context: RenderContext
    ): { label: string; url: string } | null {
        const baseUrl = process.env.AGENCY_APP_URL;
        if (!baseUrl) return null;

        const button = renderAgencyButton(situation, lang, context, baseUrl);
        return button ? { label: button.label, url: button.url } : null;
    }

    private resolveAction(
        situation: AgencyNotificationType,
        lang: Language,
        context: RenderContext
    ): AgencyNotificationAction | null {
        const baseUrl = process.env.AGENCY_APP_URL;
        const button = renderAgencyButton(situation, lang, context, baseUrl);
        if (!button) return null;

        return {
            label: button.label,
            path: button.urlSuffix,
            url: baseUrl ? button.url : undefined
        };
    }

    private async attemptDelivery(
        notification: IAgencyNotification,
        channel: AgencyDeliveryChannel,
        send: () => Promise<void>
    ): Promise<void> {
        try {
            await send();
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error(`[AgencyNotificationHandler] ${channel} delivery failed:`, message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, channel, message);
            } catch (recordErr) {
                console.error('[AgencyNotificationHandler] Failed to record delivery error:', recordErr);
            }
        }
    }

    /** Send a preformatted email notification with an optional CTA button. */
    private async sendEmail(
        agency: IDeliveryAgency,
        content: ChannelText,
        button: { label: string; url: string } | null,
        context: RenderContext
    ): Promise<void> {
        if (!agency.email_verified || !agency.email) return;

        // Business name lives on the Magazin (source of truth).
        const agencyName = (await this.magazinRepo.findNameByAgencyId(agency._id.toString())) ?? agency.display_name ?? '';

        await this.mailService.send({
            to: agency.email,
            subject: content.subject,
            template: 'agency-notification',
            type: 'SYSTEM',
            variables: {
                agencyName,
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
        agency: IDeliveryAgency,
        content: ChannelText,
        button: { label: string; url: string } | null
    ): Promise<void> {
        const message = `*${content.subject}*\n\n${content.body}`;

        const result = await this.telegramService.send({
            userId: agency.user_id.toString(),
            message,
            button: button ?? undefined
        });

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.DELIVERY_AGENCY_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error || 'Telegram delivery failed'
            );
        }
    }

    /**
     * Send a WhatsApp notification in the agency's language. Same
     * inside-window/outside-window logic as VendorNotificationEventHandler.sendWhatsApp.
     */
    private async sendWhatsApp(
        agency: IDeliveryAgency,
        notification: IAgencyNotification,
        situation: AgencyNotificationType,
        lang: Language,
        context: RenderContext
    ): Promise<void> {
        if (!this.isWhatsAppProviderConfigured()) {
            console.log('[AgencyNotificationHandler] WhatsApp not configured; skipping delivery');
            return;
        }

        if (!agency.wa?.verified || !agency.wa.wa_phone_id) return;

        const waPhoneId = agency.wa.wa_phone_id;
        const to = waPhoneId.startsWith('+') ? waPhoneId : `+${waPhoneId}`;

        const withinWindow = await this.whatsappWindow.canSendFreeMessage(waPhoneId);

        let result;
        if (withinWindow) {
            const content = renderAgencyChannelText(situation, 'whatsapp', lang, context);
            const button = process.env.AGENCY_APP_URL
                ? renderAgencyButton(situation, lang, context, process.env.AGENCY_APP_URL)
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
                    parameters: renderAgencyWhatsAppTemplateParams(situation, lang, context).map(text => ({
                        type: 'text' as const,
                        text
                    }))
                }
            ];

            const button = renderAgencyButton(situation, lang, context, process.env.AGENCY_APP_URL);
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
                    name: agencyWhatsAppTemplateName(situation),
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
                ERROR_CODES.DELIVERY_AGENCY_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error?.message || 'WhatsApp delivery failed'
            );
        }
    }
}
