import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { BookingService } from '../../booking/services/booking.service';
import { BookingStatus } from '../../booking/types/booking.types';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import {
    BotBookingCancelSchema,
    BotBookingListSchema,
    BotBookingParamSchema,
    BotNoArgsSchema,
} from '../validators/bot.validators';

const bookingService = new BookingService();

/**
 * The customer's appointments.
 *
 * ⚠ **These scope on `userId`, not `customerId`**, and that is not a slip. `Booking.userId`
 * references the `users` row, while the cart, orders, addresses, wishlist and digital
 * library all scope on the `Customer` profile. Passing the wrong one here does not throw —
 * it returns an empty list, and a customer is told they have no bookings when they have
 * several. The resolved caller carries both ids side by side precisely so neither has to
 * be derived at a call site.
 */
export class BotBookingController {
    /** `POST /bookings/list` — the sender's own bookings, filtered and paged. */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotBookingListSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const { data, total, page, limit } = await bookingService.getUserBookings(caller.userId, {
            status: query.status as BookingStatus | undefined,
            page: query.page,
            limit: query.limit,
        });

        sendSuccess(res, data, {
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    });

    /**
     * `POST /bookings/:bookingId` — one booking.
     *
     * Scoped inside the query, so another customer's booking id is a 404 rather than a 403.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const booking = await bookingService.getUserBooking(bookingId, botCallerOf(req).userId);
        sendSuccess(res, booking);
    });

    /**
     * `POST /bookings/:bookingId/cancel` — cancel, subject to the vendor's policy.
     *
     * ⚠ **This moves money, and the outcome depends on the gateway.** A paid booking is
     * refunded automatically where the gateway supports it; on My-CoolPay — which has no
     * refund API at all — and on NotchPay, whose refunds this merchant account may not use,
     * the payment status becomes `refund_pending` and a HIGH support ticket is raised for a
     * manual payout. The service decides all of that; nothing here may second-guess it, and
     * a bot must not tell the customer their money is on its way when it is a ticket.
     *
     * A refund failure never blocks the cancellation: releasing the slot matters more, and
     * money owed is recoverable from the ticket.
     */
    static cancel = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        const { reason } = BotBookingCancelSchema.parse(req.body ?? {});
        const booking = await bookingService.cancelBooking(
            bookingId,
            botCallerOf(req).userId,
            reason,
        );
        sendSuccess(res, booking);
    });
}
