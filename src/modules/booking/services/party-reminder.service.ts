import { Types } from 'mongoose';
import { Booking, IBooking } from '../models/booking.model';
import { BookingStatus } from '../types/booking.types';
import { partyReminderPath, partyReminderRefusal, ReminderSender } from '../domain/party-reminder';
import { ProductModel } from '../../catalog/models';
import { CustomerModel } from '../../customers/customer.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { StoreRepository } from '../../store/repositories/store.repository';
import { getCustomerNotificationHandler } from '../../notifications/customer-notification-event-consumer';
import { getVendorNotificationHandler } from '../../notifications/vendor-notification-event-consumer';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * The one-time reminder a vendor and a customer can send each other about an appointment. The rule
 * is `domain/party-reminder.ts`; plan and decisions: `PRODUCTION-READINESS/BOOKING-PARTY-REMINDER-PLAN.md`.
 *
 * ── CLAIM FIRST, SEND SECOND ─────────────────────────────────────────────────
 * The claim is one `findOneAndUpdate` whose filter holds the scope, the status, the start time and
 * "not yet sent", so of two simultaneous taps one wins, and a booking cancelled in the same instant
 * is not reminded. If the inbox row then cannot be written the claim is released: a reminder nobody
 * received is not spent. A failed WhatsApp, Telegram or email send does NOT release it, because the
 * inbox row and the push still reached them.
 *
 * ⚠ **`timestamps: false` on both writes.** wi-admin's `payment_stuck` queue is
 * `paymentStatus: pending` + `updatedAt` older than 30 minutes, so bumping `updatedAt` here would
 * hide a stuck payment from administrators every time somebody sent a reminder.
 */
export class PartyReminderService {
    constructor(
        private readonly vendorRepo = new VendorRepository(),
        private readonly storeRepo = new StoreRepository(),
    ) { }

    /** The customer's one reminder to the vendor. Another customer's booking is a 404. */
    async remindVendor(bookingId: string, userId: string): Promise<IBooking> {
        const scope = { userId: new Types.ObjectId(userId) };
        const booking = await this.loadOr404(bookingId, scope);
        this.assertMaySend(booking, 'customer');

        const customer = await CustomerModel.findOne({ user_id: booking.userId }).select('name').lean();
        const claimed = await this.claim(bookingId, scope, 'customer');
        return this.sendOrRelease(claimed, 'customer', async () => {
            await getVendorNotificationHandler().sendBookingReminderFromCustomer({
                vendorId: claimed.vendorId.toString(),
                bookingId: claimed._id.toString(),
                bookingNumber: claimed.bookingNumber,
                serviceName: await this.serviceNameOf(claimed),
                customerName: (customer as { name?: string } | null)?.name,
                startAt: claimed.startAt,
            });
        });
    }

    /** The shop's one reminder to the customer. Another shop's booking is a 404. */
    async remindCustomer(bookingId: string, vendorId: string): Promise<IBooking> {
        const scope = { vendorId: new Types.ObjectId(vendorId) };
        const booking = await this.loadOr404(bookingId, scope);
        this.assertMaySend(booking, 'vendor');

        // Checked BEFORE the claim: a vendor booking on their own login has nobody to remind, and
        // that must not spend the reminder.
        const customer = await CustomerModel.findOne({ user_id: booking.userId });
        if (!customer) {
            throw createAppError(
                ERROR_CODES.BOOKING_REMINDER_NOT_APPLICABLE,
                409,
                'This booking has no customer account to remind.',
            );
        }

        const claimed = await this.claim(bookingId, scope, 'vendor');
        return this.sendOrRelease(claimed, 'vendor', async () => {
            await getCustomerNotificationHandler().sendBookingReminderFromVendor({
                customer,
                bookingId: claimed._id.toString(),
                serviceName: await this.serviceNameOf(claimed),
                vendorName: await this.shopNameOf(vendorId),
                startAt: claimed.startAt,
            });
        });
    }

    private async loadOr404(bookingId: string, scope: Record<string, Types.ObjectId>): Promise<IBooking> {
        const booking = Types.ObjectId.isValid(bookingId)
            ? await Booking.findOne({ _id: bookingId, ...scope, deletedAt: null })
            : null;
        if (!booking) throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');
        return booking;
    }

    private assertMaySend(booking: IBooking, sender: ReminderSender): void {
        const refusal = partyReminderRefusal(booking, sender);
        if (refusal === 'not_applicable') {
            throw createAppError(ERROR_CODES.BOOKING_REMINDER_NOT_APPLICABLE, 409, undefined, {
                status: booking.status,
                startAt: booking.startAt,
            });
        }
        if (refusal === 'already_sent') {
            const stamps = booking.partyReminders;
            throw createAppError(ERROR_CODES.BOOKING_REMINDER_ALREADY_SENT, 409, undefined, {
                sentAt: sender === 'customer' ? stamps?.toVendorAt : stamps?.toCustomerAt,
            });
        }
    }

    private async claim(
        bookingId: string,
        scope: Record<string, Types.ObjectId>,
        sender: ReminderSender,
    ): Promise<IBooking> {
        const path = partyReminderPath(sender);
        const now = new Date();
        const claimed = await Booking.findOneAndUpdate(
            {
                _id: bookingId,
                ...scope,
                deletedAt: null,
                status: BookingStatus.CONFIRMED,
                startAt: { $gt: now },
                [path]: null,
            },
            { $set: { [path]: now } },
            { new: true, timestamps: false },
        );
        if (claimed) return claimed;

        // Lost a race, or the booking changed since it was read: say which.
        this.assertMaySend(await this.loadOr404(bookingId, scope), sender);
        throw createAppError(ERROR_CODES.BOOKING_REMINDER_NOT_APPLICABLE, 409);
    }

    private async sendOrRelease(claimed: IBooking, sender: ReminderSender, send: () => Promise<void>): Promise<IBooking> {
        try {
            await send();
            return claimed;
        } catch (error) {
            const path = partyReminderPath(sender);
            const stamp = sender === 'customer' ? claimed.partyReminders?.toVendorAt : claimed.partyReminders?.toCustomerAt;
            try {
                await Booking.updateOne(
                    { _id: claimed._id, [path]: stamp },
                    { $set: { [path]: null } },
                    { timestamps: false },
                );
            } catch (releaseError) {
                console.error(`[PartyReminderService] Could not release the reminder on booking ${claimed._id}:`, releaseError);
            }
            throw error;
        }
    }

    private async serviceNameOf(booking: IBooking): Promise<string | null> {
        const product = await ProductModel.findById(booking.productId).select('title').lean();
        return (product as { title?: string } | null)?.title ?? null;
    }

    /** The shop's name, not the person's. The profile's display name only when there is no store. */
    private async shopNameOf(vendorId: string): Promise<string | null> {
        const shop = (await this.storeRepo.findNameByVendorId(vendorId))?.trim();
        if (shop) return shop;
        const vendor = await this.vendorRepo.findById(vendorId).catch(() => null);
        return vendor?.display_name ?? null;
    }
}

export const partyReminderService = new PartyReminderService();
