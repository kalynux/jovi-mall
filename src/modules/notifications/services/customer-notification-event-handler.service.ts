import mongoose from 'mongoose';
import { formatInTimeZone } from 'date-fns-tz';
import { CustomerNotificationRepository } from '../repositories/customer-notification.repository';
import { CustomerNotificationPreferenceRepository } from '../repositories/customer-notification-preference.repository';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { Booking } from '../../booking/models/booking.model';
import { ProductModel } from '../../catalog/models/product.model';
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
    renderCustomerQuickReplies,
    viewLineFor,
    customerWhatsAppTemplateName,
    deliveryFailureLine,
    codReadyLine,
    ticketReopenLine
} from '../catalog/customer-notification-catalog';
import type { ShipmentFailureReason } from '../../shipments/shipment.model';
import { ChannelText } from '../catalog/notification-catalog';
import { Language, resolveLanguage, templateLanguage, DEFAULT_LANGUAGE } from '../catalog/notification-i18n';
import { RenderContext, toTelegramNotificationBody, toWhatsAppNotificationBody } from '../catalog/message-renderer';
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
    //   order.cancelled, order.payment.received, order.refunded,
    //   ticket.replied, ticket.awaiting_customer, ticket.resolved
    //
    // ⚠ The three `ticket.*` situations are ungated, and the reason is NOT the
    // counterparty argument the money and cancellation groups rest on — a support
    // request is the customer's own. It is narrower: all three are the ANSWER to a
    // question they asked, and `awaiting_customer` is the platform saying it is
    // blocked on them. A preference that silenced those would mute the reply to your
    // own question and then hold the request open waiting for you, which is not a
    // setting anybody means to choose. No new preference key was added for them
    // either — one that can only sensibly hold one value is a switch with a wrong
    // position.
};

/**
 * Which of the eight ticket statuses a customer is told about (GAP-012).
 *
 * Exported and PURE so `test:customer-notifications` can drive the whole table without a
 * database — the same reason `deriveWorkingState` and `aggregatePaymentStatus` are extracted.
 * The handler below does the I/O; this is the policy, and the policy is what a regression
 * would silently change.
 *
 * ⚠ **Five of the eight are deliberately silent.** `in_progress` and the four
 * `waiting_on_{admin,vendor,agency,agent}` all mean "somebody else has it" — internal
 * progress, not news. This is the same rule `handleShipmentStatusChanged` applies to
 * `assigned` and `handing_over`, and for the same reason: forwarding them trains people to
 * ignore the channel that carries the answer.
 *
 * ⚠ **`open` is silent too, and that is not an oversight.** A customer arriving at `open` has
 * either just created the request — they know — or had it REOPENED, which only happens
 * because they replied. Both cases are the customer's own action.
 */
export function customerTicketSituationFor(
    newStatus: string | undefined
): CustomerNotificationType | null {
    if (newStatus === 'waiting_on_customer') return 'ticket.awaiting_customer';
    // Both terminal statuses share a situation. They do NOT share a sentence — only one can
    // be reopened by replying, and `reopenLine` carries the difference.
    if (newStatus === 'resolved' || newStatus === 'closed') return 'ticket.resolved';
    return null;
}

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
                /**
                 * Only for the "Book again" quick reply, and deliberately looked up rather
                 * than taken from the event: `booking.cancelled`'s payload carries
                 * `productTitle` but no id, and widening it would be an event-shape change
                 * in the booking module for one button. A miss leaves the key absent, which
                 * DROPS the button — the right outcome when the service no longer exists.
                 */
                productId: await this.bookingProductId(p.bookingId),
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

        /**
         * ⛔ **The payload is ENRICHED from the booking, and without it this message said "XAF 0".**
         *
         * `BookingService.markAsPaidByCash` — the only publisher of this event — sends no amount,
         * no currency, no service name and no time. This handler used to fill those with
         * `amount ?? 0` and an empty `startAt`, so the one booking payment confirmation that
         * actually fired told a customer *"Payment received: XAF 0 … for your service on ."* Fields
         * the publisher does send still win; the booking only fills the gaps.
         */
        const booking = await this.bookingContext(p.bookingId, customer, lang);

        await this.notify({
            situation,
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.${situation}:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: p.productTitle ?? booking?.serviceName ?? this.genericService(lang),
                startAt: p.startAt
                    ? this.formatMoment(p.startAt, customer, lang)
                    : booking?.startAt ?? '',
                currency: p.currency ?? booking?.currency ?? 'XAF',
                amountFormatted: this.formatAmount(p.amount ?? booking?.price ?? 0)
            }
        });
    }

    /**
     * ⭐ An ONLINE booking payment went through — and until this handler existed, nobody told the
     * customer.
     *
     * ── WHY A SUBSCRIBER, NOT A NEW PUBLISHER ─────────────────────────────────
     * The orchestrator always published `payment.received.full` / `.partial` for a booking,
     * carrying `aggregateType: 'booking'`; the vendor stack heard it and this stack returned on it.
     * The gap was a missing subscriber. Publishing a second event for one payment would give two
     * audiences two chances to disagree about it.
     *
     * ⚠ **Routed on `purpose`, never on full vs partial.** The event name compares THIS payment
     * with the original price, so a balance arrives as `partial` when it is smaller and `full`
     * when it is larger.
     *
     * ⚠ **A BALANCE payment is deliberately NOT announced here yet, and that is an open decision,
     * not an oversight.** `booking.payment.received`'s approved copy ends *"Nothing else to do — see
     * you then"*, which is false for a balance: a balance is paid AFTER the appointment happened.
     * Reusing it would send a sentence about the future for a visit that is over, and its words
     * live in a template Meta has already approved, so they cannot be edited here. Whether a
     * balance gets its own message (and a new template to approve) belongs to the proactive-message
     * design, where the template budget is decided once. Until then a balance payment stays silent
     * rather than wrong.
     *
     * ⚠ **Shares its idempotency key with the cash path on purpose**
     * (`customer.booking.payment.received:<bookingId>`): one booking is paid once, by one method,
     * and must never be confirmed twice.
     */
    async handleBookingPaymentReceived(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            aggregateType?: string;
            bookingId?: string;
            userId?: string;
            purpose?: string;
            amount?: number;
            currency?: string;
        };

        if (p.aggregateType !== 'booking' || !p.bookingId) return;

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);
        const booking = await this.bookingContext(p.bookingId, customer, lang);

        /**
         * ⭐ **A balance gets its OWN situation; it used to get silence.**
         *
         * This was `if (p.purpose === 'booking_balance') return;` — a deliberate early exit,
         * because `booking.payment.received` ends "see you then" and a balance is paid after
         * the appointment. Avoiding the false sentence by saying nothing left a customer who
         * had just handed over money with no confirmation at all.
         *
         * ⚠ **The two situations are told apart by `purpose`, exactly as the FAILURE twin
         * keys its idempotency on it** — and for the same underlying reason: a customer can
         * pay, and fail to pay, at both the original price and the balance, so the two must
         * never collapse onto one record.
         */
        const isBalance = p.purpose === 'booking_balance';

        await this.notify({
            situation: isBalance ? 'booking.balance.received' : 'booking.payment.received',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: isBalance
                ? `customer.booking.balance.received:${p.bookingId}`
                : `customer.booking.payment.received:${p.bookingId}`,
            context: {
                bookingId: p.bookingId,
                serviceName: booking?.serviceName ?? this.genericService(lang),
                // Unused by the balance copy, which carries no time by design.
                startAt: booking?.startAt ?? '',
                currency: p.currency ?? booking?.currency ?? 'XAF',
                amountFormatted: this.formatAmount(p.amount ?? booking?.price ?? 0)
            }
        });
    }

    /**
     * ⭐ A mobile-money charge for a booking did not go through — the original price or a balance.
     *
     * The orchestrator publishes `payment.failed` with `aggregateType: 'booking'` ONLY where the
     * gateway gave a verdict (webhook, verify / reconciliation sweep), on the transition into a dead
     * status — never from the catch of the gateway call, where a timeout cannot be told from a
     * refusal and a charge may still be live. Those exclusions are the orchestrator's and are
     * pinned there; this handler trusts that anything reaching it is a real failure.
     *
     * ⚠ **Both purposes are announced**, unlike success: `booking.payment_failed`'s copy was
     * written with no time and no "see you then", so the same sentence is true for a first payment
     * and for a balance.
     *
     * ⚠ **The key separates the original price from a balance**, because they are different charges
     * with different amounts and a customer can fail at both.
     */
    async handleBookingPaymentFailed(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            aggregateType?: string;
            bookingId?: string;
            userId?: string;
            purpose?: string;
            amount?: number;
            currency?: string;
            /** The failed charge, for the "Try again" quick reply. Published already. */
            paymentId?: string;
        };

        if (p.aggregateType !== 'booking' || !p.bookingId) return;

        const customer = await this.resolveCustomerByUserId(undefined, p.userId);
        if (!customer) return;
        const lang = resolveLanguage(customer);
        const booking = await this.bookingContext(p.bookingId, customer, lang);
        const isBalance = p.purpose === 'booking_balance';

        await this.notify({
            situation: 'booking.payment_failed',
            customerId: customer._id.toString(),
            aggregateType: 'booking',
            aggregateId: p.bookingId,
            idempotencyKey: `customer.booking.payment_failed:${p.bookingId}${isBalance ? ':balance' : ''}`,
            context: {
                bookingId: p.bookingId,
                /**
                 * The charge that failed, for the "Try again" quick reply. `paymentId` is
                 * already on the event — the orchestrator publishes it on both the booking
                 * and the order branch — so nothing new is emitted for this.
                 *
                 * ⚠ **The tap MUST carry this id**, for the reason `paymentTap` documents:
                 * a button outlives the payment it was drawn for, and a "Try again" that
                 * resolved "my latest payment" would charge a different basket than the
                 * message beside it names. Absent, the button is dropped rather than
                 * guessing.
                 */
                transactionId: p.paymentId ?? '',
                serviceName: booking?.serviceName ?? this.genericService(lang),
                currency: p.currency ?? booking?.currency ?? 'XAF',
                amountFormatted: this.formatAmount(p.amount ?? 0)
            }
        });
    }

    /**
     * What a booking message needs to say about the booking itself, read from the booking.
     *
     * ⚠ **Null rather than a throw on any miss.** A notification must never fail because a product
     * was since deleted or a booking id is stale; the callers fall back to the localized generic
     * wording, which is what every other booking message here already does.
     */
    /**
     * The product a booking was made against, for the "Book again" quick reply.
     *
     * ⚠ **Empty string on ANY miss, never a throw** — same rule as `bookingContext`. An
     * absent value drops the button (`renderCustomerQuickReplies`), which is exactly what
     * should happen when the service has since been deleted: offering to rebook something
     * that no longer exists is worse than offering nothing.
     */
    private async bookingProductId(bookingId: string): Promise<string> {
        if (!mongoose.Types.ObjectId.isValid(bookingId)) return '';
        const booking = await Booking.findById(bookingId).select('productId').lean();
        return booking?.productId?.toString() ?? '';
    }

    private async bookingContext(
        bookingId: string,
        customer: ICustomer,
        lang: Language
    ): Promise<{ serviceName: string | null; startAt: string; currency: string; price: number } | null> {
        if (!mongoose.Types.ObjectId.isValid(bookingId)) return null;
        const booking = await Booking.findById(bookingId)
            .select('productId startAt currency priceSnapshot')
            .lean();
        if (!booking) return null;

        const product = booking.productId
            ? await ProductModel.findById(booking.productId).select('title').lean()
            : null;

        return {
            serviceName: (product as { title?: string } | null)?.title ?? null,
            startAt: booking.startAt ? this.formatMoment(booking.startAt, customer, lang) : '',
            currency: booking.currency,
            price: booking.priceSnapshot
        };
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

    /**
     * ⭐ The charge did not go through, and until this existed nobody told the customer.
     *
     * ── WHAT WAS WRONG ──────────────────────────────────────────────────────
     * Every other checkout outcome spoke. A failed payment did not: the orchestrator published
     * `payment.received.full` on success and published nothing at all on FAILED or CANCELLED,
     * so a refused mobile-money push was indistinguishable from a successful payment that had
     * gone quiet. The customer waited for an order that was never coming — at the exact moment
     * they most needed to hear from us, and with the copy for it already sitting in the
     * catalogue.
     *
     * ── THREE THINGS THE COPY MUST KEEP DOING, ALL LOAD-BEARING ─────────────
     * They belong to `order.payment_failed`'s own entry, and they constrain this handler too
     * because they decide what may be interpolated:
     *
     *   - **It does not say cancelled.** The basket survives, the orders exist and the charge
     *     is retryable (`checkout_retry_payment`). Announcing a cancellation would destroy a
     *     recoverable sale and send the customer back to start from nothing.
     *   - **It blames nobody.** The common causes are an unapproved prompt and a timeout,
     *     neither of which is a judgement on the customer — which is also why the gateway's own
     *     `reason` is NEVER relayed. It is provider-sourced text that names provider codes.
     *   - **It names the amount**, so a customer with two orders in flight knows which this is.
     *
     * ── ⚠ IT IS UNGATED BY PREFERENCE, AND THAT IS THE MONEY RULE ───────────
     * `SITUATION_PREFERENCE` deliberately has no key for it. Money and cancellations carry
     * none, so no setting can silence them — and this is the strongest case for that rule on
     * the whole table: a customer who muted "order updates" and then quietly lost an order to
     * a failed charge would have muted the one message that was not optional.
     *
     * ⚠ **De-duplicated by the orchestrator's transition guard, not by the key alone.**
     * `createIfNotExists` upserts the in-app row but `dispatch` still re-delivers the push and
     * the WhatsApp template, so what actually stops three identical messages is that the
     * publisher fires on the *change* into a dead status. The key is the backstop.
     */
    async handleOrderPaymentFailed(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            orderId?: string;
            customerId?: string;
            orderNumber?: string;
            amount: number;
            currency: string;
            aggregateType?: string;
            /** The failed charge, for the "Try again" quick reply. Published already. */
            paymentId?: string;
        };

        // The same charge pipeline carries bookings, plan purchases and credit top-ups.
        // No orderId → not ours, exactly as `handleOrderPaymentReceived` decides.
        if (!p.orderId || (p.aggregateType && p.aggregateType !== 'order')) return;

        const { customer, orderNumber } = await this.customerFromOrder(p.orderId, p.customerId);
        if (!customer) return;

        await this.notify({
            situation: 'order.payment_failed',
            customerId: customer._id.toString(),
            aggregateType: 'order',
            aggregateId: p.orderId,
            idempotencyKey: `customer.order.payment_failed:${p.orderId}`,
            context: {
                orderId: p.orderId,
                /** See the booking twin: the tap must name the charge it was drawn under. */
                transactionId: p.paymentId ?? '',
                orderNumber: p.orderNumber ?? orderNumber ?? p.orderId,
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

    // ─── Support requests (GAP-012) ──────────────────────────────────────────

    /**
     * A note was added to a ticket.
     *
     * ── THREE GATES, AND EACH DROPS A DIFFERENT WRONG RECIPIENT ─────────────
     * 1. **Public notes only.** A private note is visible to its author, admins and an
     *    explicit list; telling the customer one arrived would disclose that a
     *    conversation they cannot read is happening about them, which is the whole
     *    distinction `NoteVisibility` exists to draw.
     * 2. **Not the customer's own note.** Otherwise every message they send notifies
     *    them about themselves — and on WhatsApp, inside their own service window,
     *    immediately after they typed it.
     * 3. **A ticket the customer opened AS a customer** (`created_by_role`). Since the
     *    GAP-002 D-3 reversal every vendor, agency and agent who messages the bot holds a
     *    customer profile too, so "does this user have a customer row" no longer means
     *    "this is a customer's ticket". Without this gate a vendor's support thread about
     *    their payout would arrive in their customer inbox, in customer vocabulary.
     */
    async handleTicketNoteCreated(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            ticketId: string;
            noteId: string;
            authorRole?: string;
            visibility?: string;
        };

        if (p.visibility !== 'public') return;
        if (p.authorRole === 'customer') return;

        const ticket = await this.customerTicket(p.ticketId);
        if (!ticket) return;

        await this.notify({
            situation: 'ticket.replied',
            customerId: ticket.customer._id.toString(),
            aggregateType: 'ticket',
            aggregateId: p.ticketId,
            // Keyed on the NOTE, not the ticket: a second reply is a second thing to be
            // told about. Every other key on this handler is keyed on the aggregate
            // because those situations happen once.
            idempotencyKey: `customer.ticket.replied:${p.noteId}`,
            context: { ticketId: p.ticketId, subject: ticket.subject }
        });
    }

    /**
     * A ticket changed status.
     *
     * Only three of the eight statuses reach the customer — `waiting_on_customer`, and the
     * two terminal ones. The rest (`in_progress`, and waiting on admin/vendor/agency/agent)
     * all mean "somebody else has it", which is the same reason the shipment handler drops
     * `assigned` and `handing_over`.
     *
     * ⚠ **`resolved` and `closed` share a situation but not a sentence.** Both are terminal
     * and only one can be reopened by replying, so `reopenLine` carries the difference —
     * see `ticketReopenLine`. Collapsing them into one wording would have the platform
     * promise a route it has shut.
     */
    async handleTicketStatusChanged(event: DomainEvent): Promise<void> {
        const p = event.payload as {
            ticketId: string;
            oldStatus?: string;
            newStatus?: string;
        };

        const isClosed = p.newStatus === 'closed';
        const situation = customerTicketSituationFor(p.newStatus);
        if (!situation) return;

        const ticket = await this.customerTicket(p.ticketId);
        if (!ticket) return;

        await this.notify({
            situation,
            customerId: ticket.customer._id.toString(),
            aggregateType: 'ticket',
            aggregateId: p.ticketId,
            // The TRANSITION, not the ticket: `resolved → in_progress → resolved` is a
            // legal cycle and each arrival is worth telling somebody about, exactly as
            // `failed → in_transit → failed` is on a shipment.
            idempotencyKey: `customer.ticket.status:${p.ticketId}:${p.oldStatus ?? 'unknown'}:${p.newStatus}`,
            context: {
                ticketId: p.ticketId,
                subject: ticket.subject,
                /**
                 * ⭐ **The "Not sorted" button's condition, expressed as a present-or-absent
                 * id rather than as a second conditional mechanism.**
                 *
                 * `ticket.resolved`'s quick reply names `{{reopenableTicketId}}`, and
                 * `renderCustomerQuickReplies` drops any button whose placeholders are not
                 * supplied. So setting this only for a RESOLVED request makes the button
                 * appear exactly where `reopenLine` already promises a reply will be read,
                 * and vanish on a CLOSED one — where offering it would send somebody at a
                 * door the platform has shut, which is the fault the two sentences exist to
                 * avoid. The button and the sentence cannot disagree, because both are
                 * driven by `isClosed`.
                 */
                reopenableTicketId: isClosed ? '' : p.ticketId,
                reopenLine: ticketReopenLine(isClosed, resolveLanguage(ticket.customer))
            }
        });
    }

    /**
     * The ticket and its customer, or null when this ticket is not a customer's.
     *
     * ⚠ **The subject is TRUNCATED to 60 characters**, and that is not cosmetic. It is a
     * customer-authored string up to 200 characters that reaches a lock-screen push, an
     * email subject line and — the binding one — a WhatsApp template parameter. Meta caps a
     * parameter's length and rejects the whole send if it is exceeded, so an untruncated
     * subject would make long-titled requests silently undeliverable on the one channel
     * GAP-012 is about. Newlines are collapsed for the same reason: a template parameter
     * may not contain one at all.
     */
    private async customerTicket(
        ticketId: string
    ): Promise<{ customer: ICustomer; subject: string } | null> {
        if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) return null;

        // Lazily imported: the tickets module reaches back into notifications, and a
        // top-level import here closes a require cycle at boot — the same reason
        // `customerFromOrder` imports the order model this way.
        const { TicketModel } = await import('../../tickets/models/ticket.model');
        const ticket = await TicketModel.findById(ticketId)
            .select('subject created_by_role created_by_user_id')
            .lean();

        if (!ticket || ticket.created_by_role !== 'customer') return null;

        const customer = await CustomerModel.findOne({ user_id: ticket.created_by_user_id });
        if (!customer) return null;

        const subject = String(ticket.subject ?? '').replace(/\s+/g, ' ').trim();
        return {
            customer,
            subject: subject.length > 60 ? `${subject.slice(0, 57)}…` : subject
        };
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

        /**
         * Phase 10, stage 1: the chat channels get quick replies; email and the in-app
         * inbox deliberately do not.
         *
         * ⚠ **Email is excluded structurally, not by omission.** A tap token has nowhere
         * to go in an inbox — there is no tap-back — so email keeps the link it always
         * had. Same reasoning excludes in-app/push: a token addressed to the bot's
         * dispatcher is meaningless to the mobile app, and a control that reaches no
         * handler is worse than none.
         */
        const quickReplies = renderCustomerQuickReplies(situation, lang, context);

        if (channels.includes('telegram')) {
            const content = renderCustomerChannelText(situation, 'telegram', lang, context);
            await this.attemptDelivery(notification, 'telegram', () =>
                this.sendTelegram(customer, content, button, quickReplies)
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
        button: { label: string; url: string } | null,
        quickReplies: Array<{ token: string; label: string }> = []
    ): Promise<void> {
        // Escaped HTML, never the legacy Markdown this used to ride on — see
        // toTelegramNotificationBody for the failure it closes.
        const message = toTelegramNotificationBody(content.subject, content.body);

        /**
         * ⚠ **Telegram keeps BOTH** — an inline keyboard row mixes a URL button and
         * callback buttons freely, so nothing is displaced here and the body gains no
         * compensating link line. That is the one structural difference from WhatsApp,
         * whose interactive message is either/or.
         */
        const result = await this.telegramService.send({
            userId: customer.user_id.toString(),
            message,
            button: button ?? undefined,
            quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
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
            const quickReplies = renderCustomerQuickReplies(situation, lang, context);

            /**
             * ⭐ **Phase 10, stage 1 — the one place the two affordances COMPETE.**
             *
             * A WhatsApp interactive message is `cta_url` **or** `button` and never both:
             * `InteractiveMessage.subtype` is a discriminator, which is Meta's model, not
             * ours. So a situation with quick replies cannot also keep its URL button, and
             * the link would simply vanish from the message.
             *
             * ⚠ **So the link moves into the BODY, as one appended line** — WhatsApp
             * auto-links a bare URL in body text, and `viewLineFor` composes it from the
             * SAME label and URL the CTA button would have carried, so the two cannot
             * drift. The customer keeps both the action and the way to look at it.
             *
             * ⚠ **Only where a quick reply actually displaced the button.** A situation
             * with no quick reply takes the `ctaUrl` branch below completely unchanged —
             * same payload, same bytes — and must never gain this line.
             */
            if (quickReplies.length > 0) {
                const viewLine = viewLineFor(button);
                result = await getWhatsAppMessagingService().send(
                    WaServiceMessage.buttons({
                        to,
                        header: content.subject,
                        body: viewLine ? `${content.body}\n\n${viewLine}` : content.body,
                        buttons: quickReplies.map(q => ({ id: q.token, title: q.label }))
                    })
                );
            } else if (button) {
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
                    WaServiceMessage.text({ to, body: toWhatsAppNotificationBody(content.subject, content.body) })
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
                    /**
                     * ⚠ **`whatsappSuffix`, never `urlSuffix`.** Meta's approved button URL is
                     * `{STOREFRONT_URL}/{{1}}`, so what goes here is the whole path AFTER the
                     * host — including the locale prefix, which no other consumer of this
                     * component adds. `urlSuffix` is deliberately locale-free (it is stored as
                     * the inbox row's `action.path`, which the bot surface prefixes itself), so
                     * sending it here opens the English page for every customer.
                     */
                    parameters: [{ type: 'text', text: button.whatsappSuffix }]
                });
            }

            result = await getWhatsAppMessagingService().send({
                to,
                type: 'template',
                message: {
                    type: 'template',
                    name: customerWhatsAppTemplateName(situation),
                    /**
                     * ⛔ **`templateLanguage`, never `META_LANGUAGE_CODE[lang]`.** Our templates
                     * are approved in English and French only, so naming the customer's own
                     * language here asks Meta for a template that does not exist for `pt`, `es`
                     * or `ar` — the send is refused, the refusal is caught below and written to
                     * the row as a delivery error, and **the customer is told nothing**. Outside
                     * the 24-hour window a template is the only way to reach them, so that is
                     * total silence on exactly the messages that matter most.
                     *
                     * The fallback to English is explicit and named — see `templateLanguage`.
                     */
                    language: templateLanguage(lang),
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
