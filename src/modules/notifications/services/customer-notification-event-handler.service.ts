import mongoose from 'mongoose';
import { formatInTimeZone } from 'date-fns-tz';
import { CustomerNotificationRepository } from '../repositories/customer-notification.repository';
import { CustomerNotificationPreferenceRepository } from '../repositories/customer-notification-preference.repository';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { connectionService } from '../../channel-connections';
import { MailService } from '../../mail/mail.service';
import { TelegramNotificationService } from '../../telegram/services/telegram-notification.service';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { TemplateComponent } from '../../whatsapp/types/whatsapp-message.types';
import { FcmPushService, ANDROID_CHANNELS } from './fcm-push.service';
import {
    CustomerDeliveryChannel,
    ICustomerNotification,
    CustomerNotificationType,
    CustomerAggregateType,
    CustomerNotificationAction
} from '../models/customer-notification.model';
import { ICustomerNotificationPreference } from '../models/customer-notification-preference.model';
import {
    renderCustomerInApp,
    renderCustomerChannelText,
    renderCustomerWhatsAppTemplateParams,
    renderCustomerButton,
    customerWhatsAppTemplateName,
    deliveryFailureLine,
    codReadyLine
} from '../catalog/customer-notification-catalog';
import type { ShipmentFailureReason } from '../../shipments/shipment.model';
import { ChannelText } from '../catalog/notification-catalog';
import { Language, resolveLanguage, META_LANGUAGE_CODE, DEFAULT_LANGUAGE } from '../catalog/notification-i18n';
import { RenderContext, toTelegramNotificationBody } from '../catalog/message-renderer';
import { DomainEvent } from '../../../core/events/event-bus';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Which preference group gates a situation, if any.
 *
 * ABSENCE MEANS ALWAYS-SEND, and that is the important half of this table.
 * Money (payments, refunds, balances) and cancellations carry no key, so no
 * preference can silence them — a customer is the counterparty to someone else's
 * action there, not the owner of a dashboard. See the preference model's
 * docstring for the reasoning.
 */
const SITUATION_PREFERENCE: Partial<
    Record<CustomerNotificationType, keyof ICustomerNotificationPreference['preferences']>
> = {
    'booking.created': 'bookingUpdates',
    'booking.confirmed': 'bookingUpdates',
    'booking.rescheduled': 'bookingUpdates',
    'booking.completed': 'bookingUpdates',
    'booking.reminder': 'bookingReminders',
    'order.created': 'orderUpdates',
    'order.shipped': 'orderUpdates',
    'order.out_for_delivery': 'orderUpdates',
    'order.delivered': 'orderUpdates',
    'order.delivery_failed': 'orderUpdates'
    // Deliberately absent (always sent):
    //   booking.cancelled, booking.payment.received, booking.balance.due,
    //   booking.refunded, booking.refund.pending,
    //   order.cancelled, order.payment.received, order.refunded
};

interface DispatchParams {
    situation: CustomerNotificationType;
    customerId: string;
    aggregateType: CustomerAggregateType;
    aggregateId: string;
    idempotencyKey: string;
    context: RenderContext;
}

/**
 * CustomerNotificationEventHandler
 *
 * Fourth multi-channel counterpart to the vendor / agency / agent handlers —
 * same rules (mandatory in-app record, always-on push, at most one
 * preference-gated secondary channel, catalog-driven localized copy).
 *
 * Two things are specific to customers:
 *
 * 1. **Times are formatted in the CUSTOMER's timezone** before they reach a
 *    template. `Customer.timezone` exists and defaults to `Africa/Douala`; a
 *    reminder that prints a UTC instant is worse than no reminder.
 * 2. **Some situations cannot be muted.** See SITUATION_PREFERENCE above.
 */
export class CustomerNotificationEventHandler {
    private notificationRepo: CustomerNotificationRepository;
    private preferenceRepo: CustomerNotificationPreferenceRepository;
    private mailService: MailService;
    private telegramService: TelegramNotificationService;
    private whatsappWindow: WhatsappService;
    private fcmPushService: FcmPushService;

    constructor() {
        this.notificationRepo = new CustomerNotificationRepository();
        this.preferenceRepo = new CustomerNotificationPreferenceRepository();
        this.mailService = new MailService();
        this.telegramService = new TelegramNotificationService();
        this.whatsappWindow = new WhatsappService();
        this.fcmPushService = new FcmPushService();
    }

    private isWhatsAppProviderConfigured(): boolean {
        return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    }

    // ─── Public entry point ──────────────────────────────────────────────────

    /**
     * Send one situation to one customer.
     *
     * Public because two callers are not events: `BookingReminderWorker` (time-
     * based) and the balance-due request raised at completion. Everything else
     * arrives through the consumer's event subscriptions.
     *
     * Never throws — a notification failure must not fail the business action
     * that triggered it.
     */
    async notify(params: DispatchParams): Promise<void> {
        try {
            await this.dispatch(params);
        } catch (error) {
            console.error(
                `[CustomerNotifications] Failed to dispatch '${params.situation}' to customer ${params.customerId}:`,
                error
            );
        }
    }

    // ─── Booking events ──────────────────────────────────────────────────────

    async handleBookingCreated(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            customerId?: string;
            userId: string;
            productTitle?: string;
            vendorName?: string;
            startAt: string | Date;
            status?: string;
            requiresPayment?: boolean;
        };

        const customer = await this.resolveCustomerByUserId(p.customerId, p.userId);
        if (!customer) return;

        const lang = resolveLanguage(customer);
        const pending = p.status === 'pending';

        await this.notify({
            situation: 'booking.created',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.booking.created:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                vendorName: p.vendorName ?? this.genericVendor(lang),
                startAt: this.formatMoment(p.startAt, customer, lang),
                // Whether this is settled or waiting on the vendor is the single
                // most useful sentence in the message, and it depends on the
                // vendor's booking mode — so it is composed here, not templated.
                confirmationLine: pending
                    ? this.line(lang, {
                        en: 'The provider still needs to accept it — we will tell you as soon as they do.',
                        fr: 'Le prestataire doit encore l\'accepter — nous vous préviendrons dès que ce sera fait.',
                        pt: 'O prestador ainda tem de aceitar — avisamos assim que o fizer.',
                        es: 'El proveedor todavía debe aceptarla — te avisaremos en cuanto lo haga.',
                        ar: 'لا يزال مقدم الخدمة بحاجة إلى قبوله — سنخبرك بمجرد أن يفعل ذلك.'
                    })
                    : this.line(lang, {
                        en: 'It is confirmed.',
                        fr: 'Elle est confirmée.',
                        pt: 'Está confirmada.',
                        es: 'Está confirmada.',
                        ar: 'تم تأكيده.'
                    })
            }
        });
    }

    async handleBookingConfirmed(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            userId: string;
            productTitle?: string;
            vendorName?: string;
            startAt: string | Date;
        };

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'booking.confirmed',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.booking.confirmed:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                vendorName: p.vendorName ?? this.genericVendor(lang),
                startAt: this.formatMoment(p.startAt, customer, lang)
            }
        });
    }

    async handleBookingRescheduled(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            userId: string;
            productTitle?: string;
            startAt: string | Date;
            previousStartAt: string | Date;
        };

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'booking.rescheduled',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            // Keyed on the new time: a booking can legitimately move more than
            // once, and each move is its own message.
            idempotencyKey: `customer.booking.rescheduled:${p.bookingId}:${new Date(p.startAt).getTime()}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                startAt: this.formatMoment(p.startAt, customer, lang),
                previousStartAt: this.formatMoment(p.previousStartAt, customer, lang)
            }
        });
    }

    async handleBookingCancelled(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            userId: string;
            productTitle?: string;
            startAt: string | Date;
            cancelledByRole?: 'customer' | 'vendor' | 'system';
            paymentStatus?: string;
            priceSnapshot?: number;
            currency?: string;
        };

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'booking.cancelled',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.booking.cancelled:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                startAt: this.formatMoment(p.startAt, customer, lang),
                cancelledBy: this.actorLabel(p.cancelledByRole, lang),
                // Where the money went belongs in THIS message. Splitting it into a
                // separate refund notification that may arrive minutes later (or
                // never, if the refund path fails) is how a cancellation reads as
                // theft.
                refundLine: this.refundLine(lang, p.paymentStatus)
            }
        });
    }

    async handleBookingCompleted(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            userId: string;
            productTitle?: string;
            vendorName?: string;
            finalPrice: number;
            currency: string;
            balanceDue?: number;
        };

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);
        const balance = p.balanceDue ?? 0;

        await this.notify({
            situation: 'booking.completed',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.booking.completed:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                vendorName: p.vendorName ?? this.genericVendor(lang),
                currency: p.currency,
                finalPriceFormatted: this.formatAmount(p.finalPrice),
                balanceLine:
                    balance > 0
                        ? this.line(lang, {
                            en: 'There is a balance still to pay — see the booking.',
                            fr: 'Un solde reste à payer — voir la réservation.',
                            pt: 'Ainda há um saldo a pagar — veja a reserva.',
                            es: 'Queda un saldo por pagar — mira la reserva.',
                            ar: 'لا يزال هناك رصيد مستحق — راجع الحجز.'
                        })
                        : this.line(lang, {
                            en: 'Nothing further to pay.',
                            fr: 'Rien de plus à payer.',
                            pt: 'Nada mais a pagar.',
                            es: 'Nada más que pagar.',
                            ar: 'لا شيء آخر للدفع.'
                        })
            }
        });
    }

    async handleBookingPaymentUpdated(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            bookingId: string;
            userId: string;
            paymentStatus: string;
            productTitle?: string;
            startAt?: string | Date;
            amount?: number;
            currency?: string;
        };

        // Only the transitions a customer benefits from hearing about. `pending`
        // is the state during their own checkout — telling them is noise.
        const situation: CustomerNotificationType | null =
            p.paymentStatus === 'paid'
                ? 'booking.payment.received'
                : p.paymentStatus === 'refunded'
                    ? 'booking.refunded'
                    : p.paymentStatus === 'refund_pending'
                        ? 'booking.refund.pending'
                        : null;
        if (!situation) return;

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation,
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.${situation}:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? this.genericService(lang),
                startAt: p.startAt ? this.formatMoment(p.startAt, customer, lang) : '',
                currency: p.currency ?? 'XAF',
                amountFormatted: this.formatAmount(p.amount ?? 0)
            }
        });
    }

    // ─── Order events ────────────────────────────────────────────────────────

    async handleOrderCreated(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            orderId: string;
            customerId: string;
            orderNumber: string;
            vendorName?: string;
            totalAmount: number;
            currency: string;
            itemCount: number;
            paymentStatus?: string;
        };

        const customer = await this.loadCustomer(p.customerId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'order.created',
            customerId: customer._id.toString(),
            aggregateType: 'order',
            aggregateId: p.orderId,
            idempotencyKey: `customer.order.created:${p.orderId}`,
            context: {
                orderId: p.orderId,
                orderNumber: p.orderNumber,
                vendorName: p.vendorName ?? this.genericVendor(lang),
                itemCount: String(p.itemCount ?? 1),
                currency: p.currency,
                amountFormatted: this.formatAmount(p.totalAmount),
                paymentLine:
                    p.paymentStatus === 'paid'
                        ? this.line(lang, {
                            en: 'Payment received.',
                            fr: 'Paiement reçu.',
                            pt: 'Pagamento recebido.',
                            es: 'Pago recibido.',
                            ar: 'تم استلام الدفعة.'
                        })
                        : this.line(lang, {
                            en: 'We will confirm once payment is complete.',
                            fr: 'Nous confirmerons dès que le paiement sera finalisé.',
                            pt: 'Confirmaremos assim que o pagamento estiver concluído.',
                            es: 'Confirmaremos en cuanto se complete el pago.',
                            ar: 'سنؤكد بمجرد اكتمال الدفع.'
                        })
            }
        });
    }

    async handleOrderPaymentReceived(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            orderId: string;
            customerId?: string;
            orderNumber?: string;
            vendorName?: string;
            amount: number;
            currency: string;
            aggregateType?: string;
        };

        // The event also fires for plan purchases and credit top-ups, which are
        // not customer orders. No orderId → not ours.
        if (!p.orderId || (p.aggregateType && p.aggregateType !== 'order')) return;

        const { customer, orderNumber } = await this.customerFromOrder(p.orderId, p.customerId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'order.payment.received',
            customerId: customer._id.toString(),
            aggregateType: 'order',
            aggregateId: p.orderId,
            idempotencyKey: `customer.order.payment.received:${p.orderId}`,
            context: {
                orderId: p.orderId,
                orderNumber: p.orderNumber ?? orderNumber ?? p.orderId,
                vendorName: p.vendorName ?? this.genericVendor(lang),
                currency: p.currency,
                amountFormatted: this.formatAmount(p.amount)
            }
        });
    }

    async handleOrderCancelled(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            orderId: string;
            customerId?: string;
            orderNumber?: string;
            paymentStatus?: string;
        };

        const { customer, orderNumber } = await this.customerFromOrder(p.orderId, p.customerId);
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation: 'order.cancelled',
            customerId: customer._id.toString(),
            aggregateType: 'order',
            aggregateId: p.orderId,
            idempotencyKey: `customer.order.cancelled:${p.orderId}`,
            context: {
                orderId: p.orderId,
                orderNumber: p.orderNumber ?? orderNumber ?? p.orderId,
                refundLine: this.refundLine(lang, p.paymentStatus)
            }
        });
    }

    /**
     * Delivery progress, derived from the shipment lifecycle.
     *
     * Only four of the shipment statuses are worth a customer's attention, and
     * the mapping is deliberately narrow: `assigned`, `handing_over` and the rest
     * are internal logistics that would train someone to ignore the channel.
     */
    async handleShipmentStatusChanged(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            shipmentId: string;
            orderId: string;
            customerId?: string | null;
            status: string;
            trackingNumber?: string | null;
            failureReason?: ShipmentFailureReason | null;
            failureNote?: string | null;
        };

        const situation: CustomerNotificationType | null =
            p.status === 'picked_up'
                ? 'order.shipped'
                : p.status === 'in_transit'
                    ? 'order.out_for_delivery'
                    : p.status === 'delivered'
                        ? 'order.delivered'
                        : p.status === 'failed'
                            ? 'order.delivery_failed'
                            : null;
        if (!situation) return;

        const { customer, orderNumber, isCod, amountDue, currency } = await this.customerFromOrder(
            p.orderId,
            p.customerId ?? undefined
        );
        if (!customer) return;
        const lang = resolveLanguage(customer);

        await this.notify({
            situation,
            customerId: customer._id.toString(),
            aggregateType: 'shipment',
            aggregateId: p.shipmentId,
            // Keyed by shipment AND status: an order can have several parcels, and
            // `failed → in_transit → failed` is an allowed cycle.
            idempotencyKey: `customer.${situation}:${p.shipmentId}`,
            context: {
                orderId: p.orderId,
                orderNumber: orderNumber ?? p.orderId,
                trackingNumber: p.trackingNumber ?? '',
                // "Have the cash ready" — the out-for-delivery message exists to get
                // someone to the door, and for a COD order arriving without the
                // money is a wasted trip and a `payment_refused` failure.
                codLine: codReadyLine(isCod ?? false, amountDue ?? 0, currency ?? 'XAF', lang),
                // The agent's operational reason, phrased for the person who was
                // waiting in. `failureNote` is deliberately NOT surfaced — it is
                // internal free text written for a dispatcher.
                reasonLine: deliveryFailureLine(p.failureReason, lang)
            }
        });
    }

    // ─── Context helpers ─────────────────────────────────────────────────────

    /**
     * A booking stores `userId` (the User), not the Customer profile id, so the
     * customer is resolved through it. Returns null when there is no customer
     * profile — a vendor can book on their own account, and there is nobody to
     * notify.
     */
    private async resolveCustomerByUserId(
        customerId: string | undefined,
        userId: string | undefined
    ): Promise<ICustomer | null> {
        if (customerId) {
            const byId = await this.loadCustomer(customerId);
            if (byId) return byId;
        }
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return null;
        return CustomerModel.findOne({ user_id: new mongoose.Types.ObjectId(userId) });
    }

    private async loadCustomer(customerId: string | undefined): Promise<ICustomer | null> {
        if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) return null;
        return CustomerModel.findById(customerId);
    }

    /**
     * Resolve the customer and the order facts the copy needs.
     *
     * Always reads the order even when `customerId` is on the event: the order
     * number and the COD amount are what the messages actually say, and a
     * notification that calls an order by its ObjectId is no use to anybody.
     */
    private async customerFromOrder(
        orderId: string,
        customerId?: string
    ): Promise<{
        customer: ICustomer | null;
        orderNumber?: string;
        isCod?: boolean;
        amountDue?: number;
        currency?: string;
    }> {
        if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
            // No order to read — fall back to whatever the event named.
            return { customer: await this.loadCustomer(customerId) };
        }

        // Imported lazily: the orders module reaches back into notifications, and
        // a top-level import here closes a require cycle at boot.
        const { OrderModel } = await import('../../orders/order.model');
        const order = await OrderModel.findById(orderId)
            .select('customer_id order_number payment_method payment_status total_amount currency')
            .lean();

        if (!order) return { customer: await this.loadCustomer(customerId) };

        const isCod = order.payment_method === 'cash_on_delivery';

        return {
            customer: await this.loadCustomer(
                customerId ?? order.customer_id?.toString()
            ),
            orderNumber: order.order_number,
            isCod,
            // What is actually still owed at the door. A COD order can be
            // `partially_paid` (some shipments collected, others not), and quoting
            // the full total to someone who has already paid part of it invites an
            // argument with the agent on the doorstep.
            amountDue: isCod && order.payment_status !== 'paid' ? order.total_amount : 0,
            currency: order.currency
        };
    }

    /**
     * Format an instant in the CUSTOMER's timezone.
     *
     * `Customer.timezone` is required and defaults to `Africa/Douala`. Printing a
     * UTC instant to somebody who is being told when to turn up is the same class
     * of bug the availability rules had.
     */
    private formatMoment(value: string | Date, customer: ICustomer, lang: Language): string {
        const date = value instanceof Date ? value : new Date(value);
        if (isNaN(date.getTime())) return '';

        const timezone = customer.timezone || 'Africa/Douala';
        try {
            // Locale-neutral and unambiguous — no month names to translate, and no
            // US/EU day-month ambiguity.
            return formatInTimeZone(date, timezone, 'yyyy-MM-dd HH:mm');
        } catch {
            void lang;
            return date.toISOString().slice(0, 16).replace('T', ' ');
        }
    }

    /** Amounts are whole units of the smallest denomination (XAF has no cents). */
    private formatAmount(amount: number): string {
        return new Intl.NumberFormat('en-US').format(Math.round(amount));
    }

    /** Pick one pre-written localized line. */
    private line(lang: Language, variants: Record<Language, string>): string {
        return variants[lang] ?? variants[DEFAULT_LANGUAGE];
    }

    private genericService(lang: Language): string {
        return this.line(lang, {
            en: 'your service',
            fr: 'votre service',
            pt: 'o seu serviço',
            es: 'tu servicio',
            ar: 'خدمتك'
        });
    }

    private genericVendor(lang: Language): string {
        return this.line(lang, {
            en: 'the provider',
            fr: 'le prestataire',
            pt: 'o prestador',
            es: 'el proveedor',
            ar: 'مقدم الخدمة'
        });
    }

    private actorLabel(role: string | undefined, lang: Language): string {
        if (role === 'customer') {
            return this.line(lang, {
                en: 'you', fr: 'vous', pt: 'si', es: 'ti', ar: 'أنت'
            });
        }
        if (role === 'system') {
            return this.line(lang, {
                en: 'the system (payment was not completed in time)',
                fr: 'le système (le paiement n\'a pas été finalisé à temps)',
                pt: 'o sistema (o pagamento não foi concluído a tempo)',
                es: 'el sistema (el pago no se completó a tiempo)',
                ar: 'النظام (لم يكتمل الدفع في الوقت المحدد)'
            });
        }
        return this.line(lang, {
            en: 'the provider',
            fr: 'le prestataire',
            pt: 'o prestador',
            es: 'el proveedor',
            ar: 'مقدم الخدمة'
        });
    }

    /** What happens to the money, in one sentence, given a payment status. */
    private refundLine(lang: Language, paymentStatus: string | undefined): string {
        if (paymentStatus === 'refunded') {
            return this.line(lang, {
                en: 'Your payment has been refunded and usually appears within a few working days.',
                fr: 'Votre paiement a été remboursé et apparaît généralement sous quelques jours ouvrés.',
                pt: 'O seu pagamento foi reembolsado e costuma aparecer em poucos dias úteis.',
                es: 'Tu pago ha sido reembolsado y suele aparecer en unos días hábiles.',
                ar: 'تم رد دفعتك وعادة ما تظهر خلال أيام عمل قليلة.'
            });
        }
        if (paymentStatus === 'refund_pending') {
            return this.line(lang, {
                en: 'We owe you a refund and our team is sending it by hand — we will confirm when it is done.',
                fr: 'Nous vous devons un remboursement et notre équipe l\'envoie manuellement — nous confirmerons une fois effectué.',
                pt: 'Devemos-lhe um reembolso e a nossa equipa está a enviá-lo manualmente — confirmaremos quando estiver feito.',
                es: 'Te debemos un reembolso y nuestro equipo lo está enviando a mano — te confirmaremos cuando esté hecho.',
                ar: 'ندين لك باسترداد وفريقنا يرسله يدويًا — سنؤكد لك عند الانتهاء.'
            });
        }
        if (paymentStatus === 'paid') {
            return this.line(lang, {
                en: 'Your payment is being refunded.',
                fr: 'Votre paiement est en cours de remboursement.',
                pt: 'O seu pagamento está a ser reembolsado.',
                es: 'Tu pago se está reembolsando.',
                ar: 'يتم رد دفعتك.'
            });
        }
        return this.line(lang, {
            en: 'Nothing was charged.',
            fr: 'Aucun montant n\'a été débité.',
            pt: 'Não foi cobrado nada.',
            es: 'No se cobró nada.',
            ar: 'لم يتم خصم أي مبلغ.'
        });
    }

    // ─── Dispatch + delivery ─────────────────────────────────────────────────

    private async dispatch(params: DispatchParams): Promise<void> {
        const customer = await this.loadCustomer(params.customerId);
        if (!customer) return;

        const lang = resolveLanguage(customer);
        const prefs = await this.preferenceRepo.getByCustomer(params.customerId);

        // A muted group suppresses the whole notification, in-app record included.
        // Money and cancellations carry no key and therefore cannot be muted.
        const prefKey = SITUATION_PREFERENCE[params.situation];
        if (prefKey && prefs.preferences[prefKey] === false) return;

        const deliveredVia = await this.determineDeliveryChannels(customer, prefs);
        const inApp = renderCustomerInApp(params.situation, lang, params.context);
        const action = this.resolveAction(params.situation, lang, params.context);

        const notification = await this.notificationRepo.createIfNotExists({
            customerId: params.customerId,
            type: params.situation,
            title: inApp.title,
            message: inApp.message,
            aggregateType: params.aggregateType,
            aggregateId: params.aggregateId,
            action: action ?? undefined,
            deliveredVia,
            idempotencyKey: params.idempotencyKey
        });

        await this.deliverPush(notification, params.situation, inApp, action, customer);
        await this.deliverToSecondaryChannels(
            notification,
            deliveredVia,
            params.situation,
            lang,
            customer,
            params.context
        );
    }

    private async deliverPush(
        notification: ICustomerNotification,
        situation: CustomerNotificationType,
        inApp: { title: string; message: string },
        action: CustomerNotificationAction | null,
        customer: ICustomer
    ): Promise<void> {
        try {
            const targeted = await this.fcmPushService.sendToUser(customer.user_id.toString(), {
                title: inApp.title,
                body: inApp.message,
                channelId: ANDROID_CHANNELS.DEFAULT,
                data: {
                    type: situation,
                    aggregateType: notification.aggregateType,
                    aggregateId: notification.aggregateId.toString(),
                    path: action?.path,
                    url: action?.url
                }
            });

            if (targeted > 0) {
                await this.notificationRepo.addDeliveredChannel(
                    notification._id as mongoose.Types.ObjectId,
                    'push'
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[CustomerNotificationHandler] push delivery failed:', message);
            try {
                await this.notificationRepo.recordDeliveryError(
                    notification._id as mongoose.Types.ObjectId,
                    'push',
                    message
                );
            } catch (recordErr) {
                console.error('[CustomerNotificationHandler] Failed to record push error:', recordErr);
            }
        }
    }

    /**
     * At most ONE secondary channel, and only if it is verified.
     * Priority order: telegram > email > whatsapp — same as the sibling stacks.
     */
    private async determineDeliveryChannels(
        customer: ICustomer,
        prefs: ICustomerNotificationPreference
    ): Promise<CustomerDeliveryChannel[]> {
        const channels: CustomerDeliveryChannel[] = ['in-app'];

        // Both channels resolved in ONE query, then reused by the branches
        // below. Telegram is no longer gated on a second `isActive` flag:
        // muting is `telegramEnabled` alone, exactly as WhatsApp already
        // worked. See connections/services/connection.service.ts.
        const connections = await connectionService.getConnectionMap(customer.user_id);

        if (prefs.telegramEnabled && connections.telegram) {
            channels.push('telegram');
            return channels;
        }

        if (prefs.emailEnabled && customer.email_verified && customer.email) {
            channels.push('email');
            return channels;
        }

        if (prefs.whatsappEnabled && connections.whatsapp) {
            channels.push('whatsapp');
            return channels;
        }

        return channels;
    }

    private async deliverToSecondaryChannels(
        notification: ICustomerNotification,
        channels: CustomerDeliveryChannel[],
        situation: CustomerNotificationType,
        lang: Language,
        customer: ICustomer,
        context: RenderContext
    ): Promise<void> {
        const button = this.resolveButton(situation, lang, context);

        if (channels.includes('telegram')) {
            const content = renderCustomerChannelText(situation, 'telegram', lang, context);
            await this.attemptDelivery(notification, 'telegram', () =>
                this.sendTelegram(customer, content, button)
            );
        }

        if (channels.includes('email')) {
            const content = renderCustomerChannelText(situation, 'email', lang, context);
            await this.attemptDelivery(notification, 'email', () =>
                this.sendEmail(customer, content, button, context)
            );
        }

        if (channels.includes('whatsapp')) {
            await this.attemptDelivery(notification, 'whatsapp', () =>
                this.sendWhatsApp(customer, situation, lang, context, notification.idempotencyKey)
            );
        }
    }

    private resolveButton(
        situation: CustomerNotificationType,
        lang: Language,
        context: RenderContext
    ): { label: string; url: string } | null {
        const baseUrl = process.env.STOREFRONT_URL;
        if (!baseUrl) return null;

        const button = renderCustomerButton(situation, lang, context, baseUrl);
        return button ? { label: button.label, url: button.url } : null;
    }

    private resolveAction(
        situation: CustomerNotificationType,
        lang: Language,
        context: RenderContext
    ): CustomerNotificationAction | null {
        const baseUrl = process.env.STOREFRONT_URL;
        const button = renderCustomerButton(situation, lang, context, baseUrl);
        if (!button) return null;

        return {
            label: button.label,
            path: button.urlSuffix,
            url: baseUrl ? button.url : undefined
        };
    }

    private async attemptDelivery(
        notification: ICustomerNotification,
        channel: CustomerDeliveryChannel,
        send: () => Promise<void>
    ): Promise<void> {
        try {
            await send();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[CustomerNotificationHandler] ${channel} delivery failed:`, message);
            try {
                await this.notificationRepo.recordDeliveryError(
                    notification._id as mongoose.Types.ObjectId,
                    channel,
                    message
                );
            } catch (recordErr) {
                console.error('[CustomerNotificationHandler] Failed to record delivery error:', recordErr);
            }
        }
    }

    private async sendEmail(
        customer: ICustomer,
        content: ChannelText,
        button: { label: string; url: string } | null,
        context: RenderContext
    ): Promise<void> {
        if (!customer.email_verified || !customer.email) return;

        await this.mailService.send({
            to: customer.email,
            subject: content.subject,
            template: 'customer-notification',
            type: 'SYSTEM',
            variables: {
                customerName: customer.name,
                title: content.subject,
                message: content.body,
                actionLabel: button?.label ?? null,
                actionUrl: button?.url ?? null,
                ...context
            }
        });
    }

    private async sendTelegram(
        customer: ICustomer,
        content: ChannelText,
        button: { label: string; url: string } | null
    ): Promise<void> {
        // Escaped HTML, never the legacy Markdown this used to ride on — see
        // toTelegramNotificationBody for the failure it closes.
        const message = toTelegramNotificationBody(content.subject, content.body);

        const result = await this.telegramService.send({
            userId: customer.user_id.toString(),
            message,
            button: button ?? undefined,
            parseMode: 'HTML'
        });

        if (!result.success) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_DELIVERY_FAILED,
                502,
                result.error || 'Telegram delivery failed'
            );
        }
    }

    /**
     * WhatsApp, respecting the 24-hour service window: free-form text inside it,
     * an approved template outside. Same logic as the sibling handlers.
     */
    private async sendWhatsApp(
        customer: ICustomer,
        situation: CustomerNotificationType,
        lang: Language,
        context: RenderContext,
        idempotencyKey: string
    ): Promise<void> {
        if (!this.isWhatsAppProviderConfigured()) {
            console.log('[CustomerNotificationHandler] WhatsApp not configured; skipping delivery');
            return;
        }

        // The address comes from the connections store now, not from a `wa`
        // sub-document on the role entity. One person, one WhatsApp number,
        // whichever role this notification is for.
        const connection = await connectionService.getConnection(customer.user_id, 'whatsapp');
        if (!connection) return;

        const waPhoneId = connection.external_id;
        const to = waPhoneId.startsWith('+') ? waPhoneId : `+${waPhoneId}`;

        const withinWindow = await this.whatsappWindow.canSendFreeMessage(waPhoneId);

        let result;
        if (withinWindow) {
            const content = renderCustomerChannelText(situation, 'whatsapp', lang, context);
            const button = process.env.STOREFRONT_URL
                ? renderCustomerButton(situation, lang, context, process.env.STOREFRONT_URL)
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
                    parameters: renderCustomerWhatsAppTemplateParams(situation, lang, context).map(
                        text => ({ type: 'text' as const, text })
                    )
                }
            ];

            const button = renderCustomerButton(situation, lang, context, process.env.STOREFRONT_URL);
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
                    name: customerWhatsAppTemplateName(situation),
                    language: META_LANGUAGE_CODE[lang],
                    components
                },
                meta: {
                    idempotencyKey: `notif:${idempotencyKey}:whatsapp`
                }
            });
        }

        if (!result?.success) {
            throw createAppError(
                ERROR_CODES.CUSTOMER_NOTIFICATION_DELIVERY_FAILED,
                502,
                result?.error?.message || 'WhatsApp delivery failed'
            );
        }
    }
}
