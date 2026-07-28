import mongoose from 'mongoose';
import { VendorNotificationRepository } from '../repositories/vendor-notification.repository';
import { VendorNotificationPreferenceRepository } from '../repositories/vendor-notification-preference.repository';
import { FcmPushService } from './fcm-push.service';
import { VendorRepository } from '../../vendors/vendor.repository';
import { StoreRepository } from '../../store/repositories/store.repository';
import { IVendor } from '../../vendors/vendor.model';
import { TelegramRepository } from '../../telegram/telegram.repository';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import {
    DeliveryChannel,
    IVendorNotification,
    NotificationType,
    AggregateType,
    NotificationAction
} from '../models/vendor-notification.model';
import { IVendorNotificationPreference } from '../models/vendor-notification-preference.model';
import {
    renderInApp,
    renderChannelText,
    renderWhatsAppTemplateParams,
    renderButton,
    whatsAppTemplateName,
    ChannelText
} from '../catalog/notification-catalog';
import { Language, resolveLanguage, META_LANGUAGE_CODE } from '../catalog/notification-i18n';
import { RenderContext } from '../catalog/message-renderer';
import { DomainEvent } from '../../../core/events/event-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Parameters for dispatching a single notification situation.
 */
interface DispatchParams {
    situation: NotificationType;
    prefs: IVendorNotificationPreference;
    vendorId: string | mongoose.Types.ObjectId;
    aggregateType: AggregateType;
    aggregateId: string | mongoose.Types.ObjectId;
    idempotencyKey: string;
    /** Placeholder values for catalog rendering. */
    context: RenderContext;
}

/**
 * VendorNotificationEventHandler
 *
 * Event-driven notification creation with multi-channel, multi-language delivery.
 *
 * CRITICAL Rules:
 * - Idempotency enforced via unique idempotencyKey
 * - in-app delivery is MANDATORY
 * - At most ONE secondary channel per notification
 * - Secondary-channel priority: telegram > email > whatsapp
 * - Secondary channel failures MUST NOT break flow (recorded on the notification)
 * - All copy comes from the localized catalog (no inline strings)
 * - Rendered in the recipient's preferred language
 * - No DB enrichment - use event payload only
 */
export class VendorNotificationEventHandler {
    private notificationRepo: VendorNotificationRepository;
    private preferenceRepo: VendorNotificationPreferenceRepository;
    private vendorRepo: VendorRepository;
    private storeRepo: StoreRepository;
    private telegramRepo: TelegramRepository;
    private mailService: MailService;
    private telegramService: TelegramNotificationService;
    private whatsappWindow: WhatsappService;
    private fcmPushService: FcmPushService;

    constructor() {
        this.notificationRepo = new VendorNotificationRepository();
        this.preferenceRepo = new VendorNotificationPreferenceRepository();
        this.vendorRepo = new VendorRepository();
        this.storeRepo = new StoreRepository();
        this.telegramRepo = new TelegramRepository();
        this.mailService = new MailService();
        this.telegramService = new TelegramNotificationService();
        this.whatsappWindow = new WhatsappService();
        this.fcmPushService = new FcmPushService();
    }

    /** True when the WhatsApp Cloud API provider can be constructed and used. */
    private isWhatsAppProviderConfigured(): boolean {
        return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    }

    // ─── Event handlers ──────────────────────────────────────────────────────

    /** Handle order.created event */
    async handleOrderCreated(event: DomainEvent): Promise<void> {
        try {
            const { orderId, vendorId, orderNumber, totalAmount, currency } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.orderCreated) return; // Disabled

            await this.dispatch({
                situation: 'order.created',
                prefs,
                vendorId,
                aggregateType: 'order',
                aggregateId: orderId,
                idempotencyKey: `order.created:${orderId}:${vendorId}`,
                context: {
                    orderNumber,
                    currency,
                    amountFormatted: Number(totalAmount).toLocaleString(),
                    orderId
                }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle order.created:', error);
            // Do not throw - event processing must continue
        }
    }

    /** Handle order.cancelled event */
    async handleOrderCancelled(event: DomainEvent): Promise<void> {
        try {
            const { orderId, vendorId, orderNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.orderCancelled) return;

            await this.dispatch({
                situation: 'order.cancelled',
                prefs,
                vendorId,
                aggregateType: 'order',
                aggregateId: orderId,
                idempotencyKey: `order.cancelled:${orderId}:${vendorId}`,
                context: { orderNumber, orderId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle order.cancelled:', error);
        }
    }

    /** Handle booking.created event */
    async handleBookingCreated(event: DomainEvent): Promise<void> {
        try {
            const { bookingId, vendorId, bookingNumber, serviceName, startTime } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.bookingCreated) return;

            await this.dispatch({
                situation: 'booking.created',
                prefs,
                vendorId,
                aggregateType: 'booking',
                aggregateId: bookingId,
                idempotencyKey: `booking.created:${bookingId}:${vendorId}`,
                context: {
                    bookingNumber,
                    serviceName,
                    startDate: new Date(startTime).toLocaleString(),
                    bookingId
                }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle booking.created:', error);
        }
    }

    /** Handle booking.cancelled event */
    async handleBookingCancelled(event: DomainEvent): Promise<void> {
        try {
            const { bookingId, vendorId, bookingNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.bookingCancelled) return;

            await this.dispatch({
                situation: 'booking.cancelled',
                prefs,
                vendorId,
                aggregateType: 'booking',
                aggregateId: bookingId,
                idempotencyKey: `booking.cancelled:${bookingId}:${vendorId}`,
                context: { bookingNumber, bookingId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle booking.cancelled:', error);
        }
    }

    /** Handle payment.received.partial event */
    async handlePaymentReceivedPartial(event: DomainEvent): Promise<void> {
        try {
            const { paymentId, vendorId, amount, currency, orderId } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.paymentReceivedPartial) return;

            await this.dispatch({
                situation: 'payment.received.partial',
                prefs,
                vendorId,
                aggregateType: 'payment',
                aggregateId: paymentId,
                idempotencyKey: `payment.received.partial:${paymentId}:${vendorId}`,
                context: {
                    currency,
                    amountFormatted: Number(amount).toLocaleString(),
                    paymentId,
                    orderId
                }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payment.received.partial:', error);
        }
    }

    /** Handle payment.received.full event */
    async handlePaymentReceivedFull(event: DomainEvent): Promise<void> {
        try {
            const { paymentId, vendorId, amount, currency, orderId } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.paymentReceivedFull) return;

            await this.dispatch({
                situation: 'payment.received.full',
                prefs,
                vendorId,
                aggregateType: 'payment',
                aggregateId: paymentId,
                idempotencyKey: `payment.received.full:${paymentId}:${vendorId}`,
                context: {
                    currency,
                    amountFormatted: Number(amount).toLocaleString(),
                    paymentId,
                    orderId
                }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payment.received.full:', error);
        }
    }

    /**
     * Handle vendor.storage.alert event
     *
     * Fired by the file-cleanup worker when a vendor's media storage usage
     * crosses a configured threshold. The worker computes a stable idempotency
     * key (vendor + threshold + period) so a given threshold alerts once per
     * period even though the sweep runs daily.
     */
    async handleStorageAlert(event: DomainEvent): Promise<void> {
        try {
            const { vendorId, usageBytes, limitBytes, percentUsed, threshold, idempotencyKey } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (prefs.preferences.storageAlert === false) return; // Opted out

            await this.dispatch({
                situation: 'storage.alert',
                prefs,
                vendorId,
                aggregateType: 'storage',
                aggregateId: vendorId,
                idempotencyKey: idempotencyKey ?? `storage.alert:${vendorId}:${threshold}`,
                context: {
                    percentUsed,
                    usageFormatted: this.formatBytes(usageBytes),
                    limitFormatted: this.formatBytes(limitBytes),
                    threshold
                }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle storage.alert:', error);
        }
    }

    /** Handle connection.request_received event (agency sent the vendor a request). */
    async handleConnectionRequestReceived(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, vendorId, agencyName } = event.payload;
            if (recipientRole !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.request_received',
                prefs,
                vendorId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.request_received:${connectionId}`,
                context: { agencyName, connectionId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle connection.request_received:', error);
        }
    }

    /** Handle connection.approved event (the agency approved/reapproved a request the vendor sent). */
    async handleConnectionApproved(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, vendorId, agencyName } = event.payload;
            if (recipientRole !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.approved',
                prefs,
                vendorId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                // Distinct key per state-change (not just per connection) since the same
                // connection can be approved, paused, and reapproved multiple times.
                idempotencyKey: `connection.approved:${connectionId}:${event.occurredAt.toISOString()}`,
                context: { agencyName, connectionId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle connection.approved:', error);
        }
    }

    /** Handle connection.rejected event (the agency rejected a request the vendor sent). */
    async handleConnectionRejected(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, vendorId, agencyName } = event.payload;
            if (recipientRole !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.rejected',
                prefs,
                vendorId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.rejected:${connectionId}:${event.occurredAt.toISOString()}`,
                context: { agencyName, connectionId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle connection.rejected:', error);
        }
    }

    /** Handle connection.reapproval_needed event (the agency changed its policies; vendor must reapprove). */
    async handleConnectionReapprovalNeeded(event: DomainEvent): Promise<void> {
        try {
            const { connectionId, recipientRole, vendorId, agencyName } = event.payload;
            if (recipientRole !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.connectionUpdated) return;

            await this.dispatch({
                situation: 'connection.reapproval_needed',
                prefs,
                vendorId,
                aggregateType: 'connection',
                aggregateId: connectionId,
                idempotencyKey: `connection.reapproval_needed:${connectionId}:${event.occurredAt.toISOString()}`,
                context: { agencyName, connectionId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle connection.reapproval_needed:', error);
        }
    }

    /** Handle payout.requested event (fires for both vendor and agency payouts). */
    async handlePayoutRequested(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.requested',
                prefs,
                vendorId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.requested:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payout.requested:', error);
        }
    }

    /** Handle payout.paid event (fires for both vendor and agency payouts). */
    async handlePayoutPaid(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.paid',
                prefs,
                vendorId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.paid:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payout.paid:', error);
        }
    }

    /** Handle payout.rejected event (fires for both vendor and agency payouts). */
    async handlePayoutRejected(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, amount, currency, payoutRequestId, ticketId } = event.payload;
            if (ownerType !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(ownerId);
            if (!prefs.preferences.payoutUpdates) return;

            await this.dispatch({
                situation: 'payout.rejected',
                prefs,
                vendorId: ownerId,
                aggregateType: 'payout',
                aggregateId: payoutRequestId,
                idempotencyKey: `payout.rejected:${payoutRequestId}`,
                context: { currency, amountFormatted: Number(amount).toLocaleString(), ticketId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payout.rejected:', error);
        }
    }

    /**
     * Handle shipment.rejected event (a delivery agency declined a shipment).
     *
     * The vendor must reassign the affected items to another agency, so the
     * notification deep-links to the order. The specific reason + note are shown
     * on the order view itself (see vendor-order.service enrichment) — this alert
     * only tells the vendor which order needs attention.
     */
    async handleShipmentRejected(event: DomainEvent): Promise<void> {
        try {
            const { shipmentId, orderId, orderNumber, vendorId, agencyName } = event.payload;
            if (!vendorId) return;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.shipmentRejected) return;

            await this.dispatch({
                situation: 'shipment.rejected',
                prefs,
                vendorId,
                aggregateType: 'order',
                aggregateId: orderId,
                // One shipment is rejected at most once (status guard on 'assigned'),
                // so the shipment id is a stable idempotency key.
                idempotencyKey: `shipment.rejected:${shipmentId}`,
                context: { orderNumber, agencyName, orderId }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle shipment.rejected:', error);
        }
    }

    /**
     * Handle plan.expiring — the vendor's subscription plan crosses into its
     * notice window. Owner-typed event shared across roles; only the vendor case
     * is ours (the agency/agent consumers handle theirs). Idempotent on the plan's
     * expiry date so a re-run on the same day does not re-notify.
     */
    async handlePlanExpiring(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, planCode, expiresAt, daysUntilExpiry } = event.payload;
            if (ownerType !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(ownerId);
            if (prefs.preferences.planUpdates === false) return; // opted out (default on)

            await this.dispatch({
                situation: 'plan.expiring',
                prefs,
                vendorId: ownerId,
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
            console.error('[NotificationHandler] Failed to handle plan.expiring:', error);
        }
    }

    /**
     * Handle plan.expired — the vendor's plan lapsed and was handed over to a
     * queued plan or downgraded to free. One message covers both (the new plan
     * code is accurate either way).
     */
    async handlePlanExpired(event: DomainEvent): Promise<void> {
        try {
            const { ownerType, ownerId, expiredPlanCode, newPlanCode } = event.payload;
            if (ownerType !== 'vendor') return;

            const prefs = await this.preferenceRepo.getByVendor(ownerId);
            if (prefs.preferences.planUpdates === false) return;

            await this.dispatch({
                situation: 'plan.expired',
                prefs,
                vendorId: ownerId,
                aggregateType: 'plan',
                aggregateId: ownerId,
                idempotencyKey: `plan.expired:${ownerId}:${expiredPlanCode}:${event.occurredAt.toISOString().slice(0, 10)}`,
                context: { expiredPlanCode, newPlanCode }
            });
        } catch (error) {
            console.error('[NotificationHandler] Failed to handle plan.expired:', error);
        }
    }

    // ─── Dispatch + delivery ─────────────────────────────────────────────────

    /**
     * Create the in-app notification (mandatory) and fan out to the selected
     * secondary channel, all rendered in the vendor's preferred language.
     */
    private async dispatch(params: DispatchParams): Promise<void> {
        const vendor = await this.vendorRepo.findById(params.vendorId.toString());
        const lang = resolveLanguage(vendor);

        const deliveredVia: DeliveryChannel[] = vendor
            ? await this.determineDeliveryChannels(vendor, params.prefs)
            : ['in-app'];

        const inApp = renderInApp(params.situation, lang, params.context);

        // The clickable action (deep-link), localized. Carried on the in-app
        // notification AND the push so the frontend can open the relevant page
        // when the notification is clicked — same action as the channel buttons.
        const action = this.resolveAction(params.situation, lang, params.context);

        const notification = await this.notificationRepo.createIfNotExists({
            vendorId: params.vendorId,
            type: params.situation,
            title: inApp.title,
            message: inApp.message,
            aggregateType: params.aggregateType,
            aggregateId: params.aggregateId,
            action: action ?? undefined,
            deliveredVia,
            idempotencyKey: params.idempotencyKey
        });

        if (vendor) {
            // Push is a companion transport for the in-app notification (not a
            // mutually-exclusive secondary channel). Fire it for every vendor
            // that has registered devices, always-on.
            await this.deliverPush(notification, params.situation, inApp, action, vendor);

            await this.deliverToSecondaryChannels(
                notification,
                deliveredVia,
                params.situation,
                lang,
                vendor,
                params.context
            );
        }
    }

    /**
     * Deliver the notification to the vendor's registered devices via FCM.
     *
     * Always-on companion to the in-app notification: best-effort, never throws.
     * Records 'push' on deliveredVia when at least one device was targeted, and
     * captures a deliveryErrors entry on total failure (in-app stays the source
     * of truth).
     */
    private async deliverPush(
        notification: IVendorNotification,
        situation: NotificationType,
        inApp: { title: string; message: string },
        action: NotificationAction | null,
        vendor: IVendor
    ): Promise<void> {
        try {
            const targeted = await this.fcmPushService.sendToUser(vendor.user_id.toString(), {
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
            console.error('[NotificationHandler] push delivery failed:', message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, 'push', message);
            } catch (recordErr) {
                console.error('[NotificationHandler] Failed to record push delivery error:', recordErr);
            }
        }
    }

    /** Human-readable byte size (B/KB/MB/GB). */
    private formatBytes(bytes: number): string {
        if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes ?? 0} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /**
     * Determine delivery channels based on preferences and live verification.
     *
     * Rules:
     * - in-app is ALWAYS included (mandatory)
     * - At most ONE secondary channel
     * - The channel must be both enabled in preferences AND verified
     * - Platform priority: telegram > email > whatsapp (first available wins)
     */
    private async determineDeliveryChannels(
        vendor: IVendor,
        prefs: IVendorNotificationPreference
    ): Promise<DeliveryChannel[]> {
        const channels: DeliveryChannel[] = ['in-app']; // Always included

        // Priority order: telegram > email > whatsapp. Pick the first that is
        // both enabled and verified.
        if (prefs.telegramEnabled) {
            const telegramLink = await this.telegramRepo.findByUserId(vendor.user_id.toString());
            if (telegramLink && telegramLink.isActive) {
                channels.push('telegram');
                return channels;
            }
        }

        if (prefs.emailEnabled && vendor.email_verified) {
            channels.push('email');
            return channels;
        }

        if (prefs.whatsappEnabled && vendor.wa?.verified) {
            channels.push('whatsapp');
            return channels;
        }

        return channels;
    }

    /**
     * Deliver notification to the selected secondary channel(s) using localized
     * catalog copy.
     *
     * Each send is awaited so failures can be recorded against the notification
     * (deliveryErrors). In-app remains the source of truth, so a secondary-channel
     * failure is captured but never breaks the flow.
     */
    private async deliverToSecondaryChannels(
        notification: IVendorNotification,
        channels: DeliveryChannel[],
        situation: NotificationType,
        lang: Language,
        vendor: IVendor,
        context: RenderContext
    ): Promise<void> {
        const button = this.resolveButton(situation, lang, context);

        if (channels.includes('telegram')) {
            const content = renderChannelText(situation, 'telegram', lang, context);
            await this.attemptDelivery(notification, 'telegram', () =>
                this.sendTelegram(vendor, content, button)
            );
        }

        if (channels.includes('email')) {
            const content = renderChannelText(situation, 'email', lang, context);
            await this.attemptDelivery(notification, 'email', () =>
                this.sendEmail(vendor, content, button, context)
            );
        }

        if (channels.includes('whatsapp')) {
            await this.attemptDelivery(notification, 'whatsapp', () =>
                this.sendWhatsApp(vendor, notification, situation, lang, context)
            );
        }
    }

    /**
     * Resolve the situation's localized action button (label + absolute URL) when
     * a deep-link base URL (VENDOR_APP_URL) is configured. Used as a native button
     * on every channel (Telegram inline keyboard, email CTA, WhatsApp cta_url).
     */
    private resolveButton(
        situation: NotificationType,
        lang: Language,
        context: RenderContext
    ): { label: string; url: string } | null {
        const baseUrl = process.env.VENDOR_APP_URL;
        if (!baseUrl) return null;

        const button = renderButton(situation, lang, context, baseUrl);
        return button ? { label: button.label, url: button.url } : null;
    }

    /**
     * Resolve the situation's localized action for the in-app/push channel.
     *
     * Unlike resolveButton (secondary channels, which need an absolute URL and
     * thus VENDOR_APP_URL), this always returns the relative `path` so the SPA
     * can route internally; `url` is added only when VENDOR_APP_URL is set.
     */
    private resolveAction(
        situation: NotificationType,
        lang: Language,
        context: RenderContext
    ): NotificationAction | null {
        const baseUrl = process.env.VENDOR_APP_URL;
        const button = renderButton(situation, lang, context, baseUrl);
        if (!button) return null;

        return {
            label: button.label,
            path: button.urlSuffix,
            url: baseUrl ? button.url : undefined
        };
    }

    /**
     * Run one channel send, recording a deliveryErrors entry only on failure.
     */
    private async attemptDelivery(
        notification: IVendorNotification,
        channel: DeliveryChannel,
        send: () => Promise<void>
    ): Promise<void> {
        try {
            await send();
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error(`[NotificationHandler] ${channel} delivery failed:`, message);
            try {
                await this.notificationRepo.recordDeliveryError(notification._id as any, channel, message);
            } catch (recordErr) {
                console.error('[NotificationHandler] Failed to record delivery error:', recordErr);
            }
        }
    }

    /** Send a preformatted email notification with an optional CTA button. */
    private async sendEmail(
        vendor: IVendor,
        content: ChannelText,
        button: { label: string; url: string } | null,
        context: RenderContext
    ): Promise<void> {
        if (!vendor.email_verified || !vendor.email) return;

        // Business name lives on the Store (source of truth).
        const vendorName = (await this.storeRepo.findNameByVendorId(vendor._id.toString())) ?? vendor.display_name ?? '';

        await this.mailService.send({
            to: vendor.email,
            subject: content.subject,
            template: 'vendor-notification',
            type: 'SYSTEM',
            variables: {
                vendorName,
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
        vendor: IVendor,
        content: ChannelText,
        button: { label: string; url: string } | null
    ): Promise<void> {
        const message = `*${content.subject}*\n\n${content.body}`;

        const result = await this.telegramService.send({
            userId: vendor.user_id.toString(),
            message,
            button: button ?? undefined
        });

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.VENDOR_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error || 'Telegram delivery failed'
            );
        }
    }

    /**
     * Send a WhatsApp notification in the vendor's language.
     *
     * Chooses the deliverable format for Meta's policy:
     * - Inside the 24h window → free-form preformatted text (+ action link)
     * - Outside the window    → the situation's approved template (catalog),
     *   sent with the matching Meta language code and an optional URL button.
     * Sent as a free system message (no billing attribution).
     */
    private async sendWhatsApp(
        vendor: IVendor,
        notification: IVendorNotification,
        situation: NotificationType,
        lang: Language,
        context: RenderContext
    ): Promise<void> {
        if (!this.isWhatsAppProviderConfigured()) {
            console.log('[NotificationHandler] WhatsApp not configured; skipping delivery');
            return;
        }

        if (!vendor.wa?.verified || !vendor.wa.wa_phone_id) return;

        const waPhoneId = vendor.wa.wa_phone_id;
        const to = waPhoneId.startsWith('+') ? waPhoneId : `+${waPhoneId}`;

        const withinWindow = await this.whatsappWindow.canSendFreeMessage(waPhoneId);

        let result;
        if (withinWindow) {
            // Inside the 24h window we can send free-form service messages. When the
            // situation has an action button, send an interactive CTA-URL message
            // (tappable button); otherwise fall back to plain text.
            const content = renderChannelText(situation, 'whatsapp', lang, context);
            const button = process.env.VENDOR_APP_URL
                ? renderButton(situation, lang, context, process.env.VENDOR_APP_URL)
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
            // Outside the window only approved templates are deliverable.
            const components: TemplateComponent[] = [
                {
                    type: 'body',
                    parameters: renderWhatsAppTemplateParams(situation, lang, context).map(text => ({
                        type: 'text' as const,
                        text
                    }))
                }
            ];

            const button = renderButton(situation, lang, context, process.env.VENDOR_APP_URL);
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
                    name: whatsAppTemplateName(situation),
                    language: META_LANGUAGE_CODE[lang],
                    components
                },
                meta: {
                    // Templates require an idempotency key; derive a stable one per notification.
                    idempotencyKey: `notif:${notification.idempotencyKey}:whatsapp`
                }
            });
        }

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.VENDOR_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error?.message || 'WhatsApp delivery failed'
            );
        }
    }
}
