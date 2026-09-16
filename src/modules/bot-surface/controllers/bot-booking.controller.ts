import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { BookingService } from '../../booking/services/booking.service';
import { BookingStatus } from '../../booking/types/booking.types';
import { productBookingService } from '../../catalog/domain/services/booking/product-booking.instance';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { windowForChat } from '../domain/bot-list-window';
import {
    BotBookingPaymentDto,
    toBotBookingDto,
    toBotSlotDto,
} from '../dto/bot-projections';
import {
    BotBookingAvailabilitySchema,
    BotBookingCancelSchema,
    BotBookingCreateSchema,
    BotBookingListSchema,
    BotBookingParamSchema,
    BotBookingPaySchema,
    BotBookingRescheduleSchema,
    BotNoArgsSchema,
} from '../validators/bot.validators';

const bookingService = new BookingService();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * How far ahead `bookings_get_availability` looks when the caller names no range.
 *
 * 21 days, which is `WINDOW_DAYS` in the storefront's own `BookingReschedule`. Copied
 * rather than shared — there is no package between the two repositories — so the two
 * doors open on the same fortnight-and-a-bit rather than on two different guesses.
 */
const BOT_AVAILABILITY_WINDOW_DAYS = 21;

/**
 * The customer's appointments.
 *
 * ⚠ **These scope on `userId`, not `customerId`**, and that is not a slip. `Booking.userId`
 * references the `users` row, while the cart, orders, addresses, wishlist and digital
 * library all scope on the `Customer` profile. Passing the wrong one here does not throw —
 * it returns an empty list, and a customer is told they have no bookings when they have
 * several. The resolved caller carries both ids side by side precisely so neither has to
 * be derived at a call site.
 *
 * ── THE SLOT HOLD IS INTRA-REQUEST, ALWAYS ──────────────────────────────────
 * The customer API splits booking into three calls — lock the slot, then commit, then
 * unlock if the user walks away — because a browser wants to hold a time while somebody
 * fills in a form. The MCP parity plan proposed mirroring that with `bookings_lock_slot`
 * and `bookings_unlock_slot` as `flow_only` tools, plus a rule that the flow must release
 * on every abandoned path.
 *
 * ⛔ **Those two tools were NOT built, and the rule they depend on is the reason.** A chat
 * turn can take minutes and can simply never come back — the customer puts the phone down
 * mid-sentence — so a hold taken on the model's initiative takes a real appointment off
 * sale for fifteen minutes for somebody who has already left. "The flow releases it on
 * every abandoned path" is a rule living in a flow author's head, which is precisely the
 * argument that made the five-item list cap structural instead of a line in the prompt
 * (`bot-list-window.ts`).
 *
 * So `create` and `reschedule` take the hold themselves, immediately before committing,
 * and release it in a `finally` when the commit fails. There is no bot-reachable path on
 * which a hold outlives the request that took it.
 *
 * ⚠ This is also strictly SAFER than the customer API, which releases the hold only on the
 * success path (`BookingService.createBooking` step 4, after the transaction). A
 * `BOOKING_SLOT_UNAVAILABLE` there leaves the hold to expire on its own TTL.
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

        const chat = windowForChat({
            items: data,
            total,
            offset: (page - 1) * limit,
            surface: 'bookings',
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items.map(toBotBookingDto), {
            meta: {
                page, limit, totalPages: Math.ceil(total / limit),
                // `total` comes from the window, which reconciles it against what was
                // actually held — see `windowForChat`. Repeating the raw one here would be
                // two sources for one number, and the spread would silently win anyway.
                ...chat.window,
            },
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
        sendSuccess(res, toBotBookingDto(booking));
    });

    /**
     * `POST /bookings/availability` — when is this service free?
     *
     * ⚠ **The range is optional here and mandatory on the customer API.** That endpoint
     * 400s without both dates because a calendar widget always knows which fortnight it is
     * drawing. A model does not, and making it compute two ISO-8601 instants is making it
     * do date arithmetic — which fails quietly, as "no availability" for a product with
     * plenty. Omitted, this looks from now to +21 days.
     *
     * ⚠ **The backing read is UNAUTHENTICATED and this route is not.** Every row on this
     * surface refuses an unresolved sender, and that is left alone rather than special-cased:
     * a sender who cannot be resolved cannot book either, and GAP-002 registers them on
     * first contact anyway.
     *
     * The window's "see the rest" link is the PRODUCT's own page rather than one of the
     * fixed account pages — a product's slots live nowhere else — which is what
     * `BotListDestination`'s `{ path }` form was added for.
     */
    static availability = asyncHandler(async (req: Request, res: Response) => {
        const query = BotBookingAvailabilitySchema.parse(req.body ?? {});

        const from = query.from ? new Date(query.from) : new Date();
        const to = query.to
            ? new Date(query.to)
            : new Date(from.getTime() + BOT_AVAILABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const slots = await productBookingService.getAvailability(query.productId, from, to);

        /**
         * ⚠ Sliced by the WINDOW, but paged by hand first: `getAvailability` answers the
         * whole range in one array — there is no repository page to ask for — so `offset`
         * has to be applied here for `hasMore` to mean anything on page 2.
         */
        const offset = (query.page - 1) * query.limit;
        const chat = windowForChat({
            items: slots.slice(offset).map(toBotSlotDto),
            total: slots.length,
            offset,
            /**
             * ⚠ The redirect-stub form (`/shop/p/:id`), not the canonical
             * `/shop/stores/:store/products/:slug`. It is the one the storefront documents
             * for exactly this case — "for links held somewhere that knows an id but not a
             * store slug" — and this surface knows only the id.
             */
            surface: { path: `/shop/p/${query.productId}` },
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items, {
            meta: {
                productId: query.productId,
                from: from.toISOString(),
                to: to.toISOString(),
                page: query.page,
                limit: query.limit,
                ...chat.window,
            },
        });
    });

    /**
     * `POST /bookings` — take the slot and book it, in one request.
     *
     * ⚠ **`requires_confirmation`, and it means the customer's own words.** This creates a
     * real appointment in a real business's calendar. "That time works" is a confirmation;
     * "what about Tuesday?" is not.
     *
     * ── WHAT THE ANSWER ACTUALLY MEANS ──────────────────────────────────────
     * A `calendar`- or `capacity`-mode product comes back **confirmed**. A `manual`-mode one
     * comes back `status: 'pending'` with `awaitingVendorApproval: true`, which is NOT a
     * payment state and must not be relayed as one — see `toBotBookingDto`.
     *
     * `payment.required` decides whether anything is owed; when it is, `bookings_pay` is the
     * next step and the appointment holds the slot meanwhile. An unpaid booking is swept by
     * `unpaid-booking-cancel.worker`, so "book now, pay later" is not indefinite.
     */
    static create = asyncHandler(async (req: Request, res: Response) => {
        const input = BotBookingCreateSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        /**
         * The hold, taken here and owned for the length of this request only.
         *
         * `lockSlot` is mode-aware — a capacity product gets a per-user key so several
         * customers can be mid-checkout on the same slot — so it is reached through
         * `productBookingService` rather than the lock service directly. A `false` means
         * somebody else is holding an exclusive slot right now.
         */
        const held = await productBookingService.lockSlot(input.productId, input.slotId, caller.userId);
        if (!held) {
            throw createAppError(ERROR_CODES.BOOKING_SLOT_LOCKED, 409, undefined, {
                slotId: input.slotId,
            });
        }

        let result;
        try {
            result = await productBookingService.bookProduct(
                input.productId,
                input.slotId,
                caller.userId,
                caller.userId,
                /**
                 * ⚠ The ONLY metadata this surface will write. The customer API forwards an
                 * arbitrary object; `createBooking` renders `metadata.notes` into the
                 * vendor's calendar event, so that one key has a defined destination and
                 * nothing else does.
                 */
                input.notes ? { notes: input.notes } : undefined,
            );
        } catch (error) {
            /**
             * ⚠ **Release on EVERY failure, which the customer API does not do.**
             * `createBooking` releases at step 4, after its transaction commits — so a
             * `BOOKING_SLOT_UNAVAILABLE` there leaves a dead hold sitting on a slot for the
             * rest of its fifteen minutes. Best-effort: a failure to release must not
             * replace the real error with a Redis one.
             */
            try {
                await productBookingService.unlockSlot(input.productId, input.slotId, caller.userId);
            } catch {
                // The TTL is the backstop. The original error is what the caller needs.
            }
            throw error;
        }

        sendSuccess(res, toBotBookingDto(result.booking), { status: 201 });
    });

    /**
     * `PATCH /bookings/:bookingId/reschedule` — move it, holding the new slot only as long
     * as the move takes.
     *
     * ✅ **A capacity-mode product CAN be rescheduled — KI-1, fixed 2026-09-06.** This note
     * used to say it could not, and it is kept because the decision it records is what made
     * the fix cheap: `BookingService.rescheduleBooking` asserted the hold with `scopeToOwner`
     * defaulted to `false` — the unscoped key — while `lockSlot` writes the owner-scoped key
     * for capacity products, so the assert always missed and every move was refused with
     * `BOOKING_SLOT_NOT_LOCKED`. It was NOT worked around here: using the unscoped key just
     * for the bot would have made this door behave differently from the one beside it, and
     * would have hidden a defect the storefront had too. Both sides were fixed at once
     * instead, in `GroupBookingService`.
     *
     * ⚠ **`lockSlot` above is still what decides the key namespace, and it must keep
     * agreeing with `GroupBookingService.resolveCapacity`.** That disagreement WAS KI-1.
     * `ProductBookingService.isCapacityProduct` now delegates to that one resolver so the
     * two cannot drift; `test:group-booking` pins it.
     */
    static reschedule = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        const { slotId } = BotBookingRescheduleSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        /**
         * Ownership FIRST, before anything is held. Rescheduling somebody else's booking is
         * a 404 either way, but taking a hold on a slot before finding that out would let an
         * unrelated id lock a stranger's appointment time for fifteen minutes.
         */
        const existing = await bookingService.getUserBooking(bookingId, caller.userId);
        const productId = referencedIdOf(existing.productId);

        const held = await productBookingService.lockSlot(productId, slotId, caller.userId);
        if (!held) {
            throw createAppError(ERROR_CODES.BOOKING_SLOT_LOCKED, 409, undefined, { slotId });
        }

        try {
            const booking = await bookingService.rescheduleBooking(bookingId, slotId, caller.userId, {
                role: 'customer',
                id: caller.userId,
            });
            sendSuccess(res, toBotBookingDto(booking));
        } catch (error) {
            try {
                await productBookingService.unlockSlot(productId, slotId, caller.userId);
            } catch {
                // The TTL is the backstop.
            }
            throw error;
        }
    });

    /**
     * `POST /bookings/:bookingId/balance` — what a completed appointment actually came to.
     *
     * A service that ran long costs more than it was quoted. This is the difference, and it
     * is a READ: nothing is charged until the customer asks, because they agreed to the
     * quote rather than to whatever the vendor settles at afterwards.
     *
     * ⚠ `creditDue` is the OTHER direction — the customer overpaid — and it is **recorded,
     * never refunded**, by explicit product decision (see the booking model). A bot must
     * report it as "the vendor settled below the quote", never as money on its way back.
     */
    static balance = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});

        const booking = await bookingService.getUserBooking(bookingId, botCallerOf(req).userId);
        const settlement = booking.settlement;

        sendSuccess(res, {
            bookingId: booking._id.toString(),
            currency: booking.currency,
            quotedPrice: booking.priceSnapshot,
            finalPrice: settlement?.finalPrice ?? null,
            balanceDue: settlement?.balanceDue ?? 0,
            balancePaid: settlement?.balancePaid ?? 0,
            outstanding: Math.max(0, (settlement?.balanceDue ?? 0) - (settlement?.balancePaid ?? 0)),
            creditDue: settlement?.creditDue ?? 0,
            settled: Boolean(settlement?.settledAt),
        });
    });

    /**
     * `POST /bookings/:bookingId/payment-status` — where the money got to.
     *
     * Built here rather than relayed, because the customer route it mirrors
     * (`GET /api/bookings/:id/payment-status`) answers a raw `transaction` object off the
     * `PaymentTransactionModel` document. `transactionId` is renamed from `id` on purpose:
     * it is the argument `payment_get_transaction`, `payment_authorize_otp` and
     * `payment_create_pay_link` all take, and a key called `id` next to a `bookingId`
     * invites a model to pass the wrong one.
     */
    static paymentStatus = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});

        const booking = await bookingService.getUserBooking(bookingId, botCallerOf(req).userId);

        let transaction: BotBookingPaymentDto['transaction'] = null;
        if (booking.paymentTransactionId) {
            const row = await PaymentTransactionModel.findById(booking.paymentTransactionId)
                .select('status gateway')
                .lean();
            if (row) {
                transaction = {
                    transactionId: booking.paymentTransactionId.toString(),
                    status: row.status,
                    gateway: row.gateway,
                };
            }
        }

        const dto: BotBookingPaymentDto = {
            bookingId: booking._id.toString(),
            status: booking.paymentStatus,
            method: booking.paymentMethod ?? null,
            required: booking.requiresPayment,
            amount: booking.priceSnapshot,
            currency: booking.currency,
            transaction,
        };

        sendSuccess(res, dto);
    });

    /**
     * `POST /bookings/:bookingId/pay` — charge the quoted price.
     *
     * ⚠ **This moves real money and pushes a prompt to a real handset**, which is why it is
     * `flow_only`: the model never holds it. The answer is a `transactionId` and, on the
     * mobile-money path, `instructions` — a USSD code to dial or an OTP to relay back
     * through `payment_authorize_otp`. On `STRIPE` it is a client secret no chat can use,
     * and the answer there is `payment_create_pay_link`.
     *
     * ⚠ **`phoneOperator` must be ASKED.** Guessing MTN for an Orange number reaches the
     * customer as "payment declined".
     *
     * The orchestrator refuses a second live charge itself (`PAYMENT_BOOKING_IN_PROGRESS`)
     * and keys its own idempotency on `(bookingId, userId, price)`, so the surface's
     * `Idempotency-Key` is the outer of two guards rather than the only one.
     */
    static pay = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        const input = BotBookingPaySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        // Ownership first — a 404 for anybody else's booking, before a gateway is touched.
        await bookingService.getUserBooking(bookingId, caller.userId);

        const result = await paymentOrchestrator.initiateBookingPayment(
            bookingId,
            input.gateway,
            channelOf(input),
        );
        sendSuccess(res, result);
    });

    /**
     * `POST /bookings/:bookingId/pay-balance` — settle what it came to above the quote.
     *
     * A SECOND payment against the same booking, and a separate orchestrator method rather
     * than a flag: almost every guard inverts. `pay` refuses an already-paid booking; this
     * one requires it, requires `status: 'completed'`, and charges `settlement.balanceDue`
     * instead of `priceSnapshot`.
     */
    static payBalance = asyncHandler(async (req: Request, res: Response) => {
        const { bookingId } = BotBookingParamSchema.parse(req.params);
        const input = BotBookingPaySchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        await bookingService.getUserBooking(bookingId, caller.userId);

        const result = await paymentOrchestrator.initiateBookingBalancePayment(
            bookingId,
            input.gateway,
            channelOf(input),
        );
        sendSuccess(res, result);
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
        sendSuccess(res, toBotBookingDto(booking));
    });
}

/**
 * The id behind a reference, whether or not it was populated.
 *
 * ⚠ **`getUserBooking` POPULATES `productId`, and `String()` of a populated document is NOT its
 * id.** On Mongoose 8 a document's `toString()` is its inspected contents —
 * `"{ title: 'Haircut', type: 'service', _id: new ObjectId('…') }"` — so the reschedule route
 * used to hand that whole string to `lockSlot` and `unlockSlot` as a product id.
 * `resolveCapacity` answers null for an invalid id, so the hold was taken UNSCOPED, while
 * `rescheduleBooking` resolved the real product and asserted the SCOPED key a group class
 * uses: every chat reschedule of a group class was refused with `BOOKING_SLOT_NOT_LOCKED` —
 * KI-1, back on this one door. A one-person appointment worked only because both sides
 * happened to agree on the unscoped key.
 *
 * Since `lockSlot` now validates the slot against the product's real availability, the same
 * string would have made EVERY chat reschedule fail. Taking the id explicitly closes both, and
 * `test:booking-slot-offer` pins this against an in-memory populated document.
 */
export function referencedIdOf(ref: unknown): string {
    if (ref !== null && typeof ref === 'object' && '_id' in ref) {
        return String((ref as { _id: unknown })._id);
    }
    return String(ref);
}

/**
 * The flat chat arguments, as the gateway-facing `channel` object.
 *
 * Flattened on the way in because a nested `channel` is one more level for a model to get
 * wrong, and rebuilt here rather than at two call sites. `cardToken` and `customerName` are
 * absent from the schema entirely — a card token has no business arriving over a chat
 * transport, and the platform knows the customer's name better than a model does.
 */
function channelOf(input: {
    phoneNumber?: string;
    phoneOperator?: 'MTN' | 'ORANGE' | 'MOOV';
    customerEmail?: string;
}) {
    return {
        ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
        ...(input.phoneOperator ? { phoneOperator: input.phoneOperator } : {}),
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
    };
}
