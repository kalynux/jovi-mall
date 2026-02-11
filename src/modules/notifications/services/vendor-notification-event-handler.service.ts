import mongoose from 'mongoose';
import { VendorNotificationRepository } from '../repositories/vendor-notification.repository';
import { VendorNotificationPreferenceRepository } from '../repositories/vendor-notification-preference.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { TelegramRepository } from '../../telegram/telegram.repository';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { DeliveryChannel } from '../models/vendor-notification.model';
import { DomainEvent } from '../../../core/events/event-bus';

/**
 * VendorNotificationEventHandler
 * 
 * Event-driven notification creation with multi-channel delivery.
 * 
 * CRITICAL Rules:
 * - Idempotency enforced via unique idempotencyKey
 * - in-app delivery is MANDATORY
 * - Only ONE secondary channel per notification
 * - Secondary channel failures MUST NOT break flow
 * - No DB enrichment - use event payload only
 */
export class VendorNotificationEventHandler {
    private notificationRepo: VendorNotificationRepository;
    private preferenceRepo: VendorNotificationPreferenceRepository;
    private vendorRepo: VendorRepository;
    private telegramRepo: TelegramRepository;
    private mailService: MailService;
    private telegramService: TelegramNotificationService;

    constructor() {
        this.notificationRepo = new VendorNotificationRepository();
        this.preferenceRepo = new VendorNotificationPreferenceRepository();
        this.vendorRepo = new VendorRepository();
        this.telegramRepo = new TelegramRepository();
        this.mailService = new MailService();
        this.telegramService = new TelegramNotificationService();
    }

    /**
     * Handle order.created event
     */
    async handleOrderCreated(event: DomainEvent): Promise<void> {
        try {
            const { orderId, vendorId, orderNumber, totalAmount, currency } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.orderCreated) return; // Disabled

            const idempotencyKey = `order.created:${orderId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const title = `New Order #${orderNumber}`;
            const message = `You received a new order for ${currency} ${totalAmount.toLocaleString()}`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'order.created',
                title,
                message,
                aggregateType: 'order',
                aggregateId: orderId,
                deliveredVia,
                idempotencyKey
            });

            // Trigger secondary channel delivery (fire-and-forget)
            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { orderNumber, totalAmount, currency, orderId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle order.created:', error);
            // Do not throw - event processing must continue
        }
    }

    /**
     * Handle order.cancelled event
     */
    async handleOrderCancelled(event: DomainEvent): Promise<void> {
        try {
            const { orderId, vendorId, orderNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.orderCancelled) return;

            const idempotencyKey = `order.cancelled:${orderId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const title = `Order Cancelled #${orderNumber}`;
            const message = `Order #${orderNumber} has been cancelled`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'order.cancelled',
                title,
                message,
                aggregateType: 'order',
                aggregateId: orderId,
                deliveredVia,
                idempotencyKey
            });

            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { orderNumber, orderId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle order.cancelled:', error);
        }
    }

    /**
     * Handle booking.created event
     */
    async handleBookingCreated(event: DomainEvent): Promise<void> {
        try {
            const { bookingId, vendorId, bookingNumber, serviceName, startTime } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.bookingCreated) return;

            const idempotencyKey = `booking.created:${bookingId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const startDate = new Date(startTime).toLocaleString();
            const title = `New Booking #${bookingNumber}`;
            const message = `New booking for ${serviceName} scheduled on ${startDate}`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'booking.created',
                title,
                message,
                aggregateType: 'booking',
                aggregateId: bookingId,
                deliveredVia,
                idempotencyKey
            });

            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { bookingNumber, serviceName, startDate, bookingId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle booking.created:', error);
        }
    }

    /**
     * Handle booking.cancelled event
     */
    async handleBookingCancelled(event: DomainEvent): Promise<void> {
        try {
            const { bookingId, vendorId, bookingNumber } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.bookingCancelled) return;

            const idempotencyKey = `booking.cancelled:${bookingId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const title = `Booking Cancelled #${bookingNumber}`;
            const message = `Booking #${bookingNumber} has been cancelled`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'booking.cancelled',
                title,
                message,
                aggregateType: 'booking',
                aggregateId: bookingId,
                deliveredVia,
                idempotencyKey
            });

            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { bookingNumber, bookingId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle booking.cancelled:', error);
        }
    }

    /**
     * Handle payment.received.partial event
     */
    async handlePaymentReceivedPartial(event: DomainEvent): Promise<void> {
        try {
            const { paymentId, vendorId, amount, currency, orderId } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.paymentReceivedPartial) return;

            const idempotencyKey = `payment.received.partial:${paymentId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const title = `Partial Payment Received`;
            const message = `Received partial payment of ${currency} ${amount.toLocaleString()}`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'payment.received.partial',
                title,
                message,
                aggregateType: 'payment',
                aggregateId: paymentId,
                deliveredVia,
                idempotencyKey
            });

            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { amount, currency, paymentId, orderId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payment.received.partial:', error);
        }
    }

    /**
     * Handle payment.received.full event
     */
    async handlePaymentReceivedFull(event: DomainEvent): Promise<void> {
        try {
            const { paymentId, vendorId, amount, currency, orderId } = event.payload;

            const prefs = await this.preferenceRepo.getByVendor(vendorId);
            if (!prefs.preferences.paymentReceivedFull) return;

            const idempotencyKey = `payment.received.full:${paymentId}:${vendorId}`;

            const deliveredVia = await this.determineDeliveryChannels(vendorId, prefs);

            const title = `Payment Received`;
            const message = `Received full payment of ${currency} ${amount.toLocaleString()}`;

            await this.notificationRepo.createIfNotExists({
                vendorId,
                type: 'payment.received.full',
                title,
                message,
                aggregateType: 'payment',
                aggregateId: paymentId,
                deliveredVia,
                idempotencyKey
            });

            await this.deliverToSecondaryChannels(vendorId, deliveredVia, {
                subject: title,
                body: message,
                templateContext: { amount, currency, paymentId, orderId }
            });

        } catch (error) {
            console.error('[NotificationHandler] Failed to handle payment.received.full:', error);
        }
    }

    /**
     * Determine delivery channels based on preferences and verification status
     * 
     * Rules:
     * - in-app is ALWAYS included (mandatory)
     * - Only ONE secondary channel
     * - Secondary channels require verification
     * - Priority: email > telegram > whatsapp
     */
    private async determineDeliveryChannels(
        vendorId: string | mongoose.Types.ObjectId,
        prefs: any
    ): Promise<DeliveryChannel[]> {
        const channels: DeliveryChannel[] = ['in-app']; // Always included

        // Get vendor for verification status
        const vendor = await this.vendorRepo.findById(vendorId.toString());
        if (!vendor) return channels;

        // Check secondary channels in priority order
        if (prefs.emailEnabled && vendor.email_verified) {
            channels.push('email');
        } else if (prefs.telegramEnabled) {
            // Check telegram link verification
            const telegramLink = await this.telegramRepo.findByUserId(vendor.user_id.toString());
            if (telegramLink && telegramLink.isActive) {
                channels.push('telegram');
            }
        } else if (prefs.whatsappEnabled && vendor.wa?.verified) {
            channels.push('whatsapp');
        }

        return channels;
    }

    /**
     * Deliver notification to secondary channels (fire-and-forget)
     * 
     * Failures are logged but do NOT break the flow.
     */
    private async deliverToSecondaryChannels(
        vendorId: string | mongoose.Types.ObjectId,
        channels: DeliveryChannel[],
        content: {
            subject: string;
            body: string;
            templateContext: any;
        }
    ): Promise<void> {
        if (channels.includes('email')) {
            this.sendEmail(vendorId, content).catch(err =>
                console.error('[NotificationHandler] Email failed:', err)
            );
        }

        if (channels.includes('telegram')) {
            this.sendTelegram(vendorId, content).catch(err =>
                console.error('[NotificationHandler] Telegram failed:', err)
            );
        }

        if (channels.includes('whatsapp')) {
            this.sendWhatsApp(vendorId, content).catch(err =>
                console.error('[NotificationHandler] WhatsApp failed:', err)
            );
        }
    }

    /**
     * Send email notification
     */
    private async sendEmail(
        vendorId: string | mongoose.Types.ObjectId,
        content: any
    ): Promise<void> {
        const vendor = await this.vendorRepo.findById(vendorId.toString());
        if (!vendor || !vendor.email_verified || !vendor.email) return;

        await this.mailService.send({
            to: vendor.email,
            subject: content.subject,
            template: 'vendor-notification',
            type: 'SYSTEM',
            variables: {
                vendorName: vendor.business_name,
                title: content.subject,
                message: content.body,
                ...content.templateContext
            }
        });
    }

    /**
     * Send Telegram notification
     */
    private async sendTelegram(
        vendorId: string | mongoose.Types.ObjectId,
        content: any
    ): Promise<void> {
        const vendor = await this.vendorRepo.findById(vendorId.toString());
        if (!vendor) return;

        // Format message for Telegram (markdown)
        const message = `*${content.subject}*\n\n${content.body}`;

        await this.telegramService.send({
            userId: vendor.user_id.toString(),
            message
        });
    }

    /**
     * Send WhatsApp notification
     * 
     * Note: This is a placeholder. WhatsApp API integration required.
     */
    private async sendWhatsApp(
        vendorId: string | mongoose.Types.ObjectId,
        content: any
    ): Promise<void> {
        const vendor = await this.vendorRepo.findById(vendorId.toString());
        if (!vendor || !vendor.wa?.verified) return;

        // TODO: Implement WhatsApp message sending via WhatsApp Business API
        // For now, just log
        console.log(`[NotificationHandler] WhatsApp delivery for vendor ${vendorId}:`, content.subject);
    }
}
