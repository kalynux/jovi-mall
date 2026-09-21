import { Request, Response } from 'express';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { TelegramBotService } from '../../../telegram/services/telegram-bot.service';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { inAppSurfaceStore } from '../../services/inapp-surface.store';
import { bookingChatReceipt } from '../../domain/bot-booking-copy';
import { botChrome } from '../../domain/bot-chrome-copy';
import { openSurfaceActionId } from '../../domain/bot-action-id';
import {
    BookingConfirmed,
    confirmBooking,
    payBooking,
    readBookingPayment,
    readBookingPicker,
    readCustomerBookings,
} from './booking.core';

const telegramBotService = new TelegramBotService();

/**
 * `bl` · `bk` — the booking screens, as pages inside Telegram.
 *
 * ── THIN ON PURPOSE ─────────────────────────────────────────────────────────
 * Every rule lives in `booking.core.ts`, because the WhatsApp Flow calls the same functions and a
 * second copy is a copy that drifts on the channel nobody can open in a browser. What a transport
 * owns is here and nowhere else: reading its own session, and saying in the chat afterwards.
 *
 * ── ⚠ THE TWO READS SPEND NOTHING; THE CONFIRM SPENDS THE HANDLE ────────────
 * A picker is re-read every time somebody changes their mind about a day, so `bl` and `bk`'s data
 * routes use `read`. The confirm uses `consume`, inside the core, which is what makes a double
 * press unable to open two appointments — the rule the checkout screen already follows.
 */
export class BookingScreensController {
    /** `GET /api/bot/miniapp/s/bl/:handle/data` — this customer's appointments. Repeatable. */
    static listData = asyncHandler(async (req: Request, res: Response) => {
        const session = await sessionOf('bl', req);
        sendSuccess(res, await readCustomerBookings({
            userId: session.owner,
            language: session.language,
        }));
    });

    /**
     * `GET /api/bot/miniapp/s/bk/:handle/data` — the days, or one day's times.
     *
     * ⚠ **Two steps behind one route, because they are two reads of one screen.** Without `?date`
     * it answers the days that actually have times; with it, that day's times. A WhatsApp form's
     * day choice triggers exactly this second call, so both channels ask the same question of the
     * same read rather than one of them holding a fortnight it cannot draw.
     */
    static slotData = asyncHandler(async (req: Request, res: Response) => {
        /**
         * ⚠ **The core reads the session itself**, so this page and the WhatsApp form get the
         * same answer from the same call — including `moving`, which only the session knows and
         * which each transport would otherwise assemble for itself.
         */
        sendSuccess(res, await readBookingPicker(String(req.params.handle ?? ''), {
            date: typeof req.query.date === 'string' ? req.query.date : null,
        }));
    });

    /**
     * `POST /api/bot/miniapp/s/bk/:handle/confirm` — SPENDS the handle and takes the time.
     *
     * ⚠ **The chat receipt is pushed BEFORE the response**, as the ticket form does and for the
     * same reason: the page may be closed the instant it gets an answer, so a push afterwards
     * races the WebView's teardown. It swallows its own failures — an appointment that exists must
     * never be reported as a failure by the message about it.
     */
    static confirm = asyncHandler(async (req: Request, res: Response) => {
        const handle = String(req.params.handle ?? '');
        const body = (req.body ?? {}) as { slotId?: unknown; notes?: unknown };
        if (typeof body.slotId !== 'string' || body.slotId.length === 0) {
            throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'slotId is required');
        }

        /**
         * ⚠ Read BEFORE the confirm, because the confirm CONSUMES the session — and the chat
         * still has to be told, in the customer's language, in the conversation it came from.
         */
        const session = await inAppSurfaceStore.read('bk', handle);

        const outcome = await confirmBooking(handle, {
            slotId: body.slotId,
            notes: typeof body.notes === 'string' ? body.notes : null,
        });

        if (session) {
            await pushReceipt(session.channel, session.externalId, session.language, outcome);
        }

        sendSuccess(res, outcome, { status: 201 });
    });

    /** `GET /api/bot/miniapp/s/bp/:handle/data` — what is owed, re-resolved now. Repeatable. */
    static payData = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await readBookingPayment(String(req.params.handle ?? '')));
    });

    /**
     * `POST /api/bot/miniapp/s/bp/:handle/pay` — SPENDS the handle and opens the charge.
     *
     * ⚠ **The answer is "the request is on its way", never "paid".** A mobile-money charge is
     * approved on a handset, minutes later, on a device this route cannot see; the outcome
     * reaches the customer through the payment path, which speaks only where the gateway gave a
     * verdict. Anything this route said about success or failure would be the screen reaching a
     * verdict the platform deliberately has not.
     *
     * ⚠ **No chat push here, unlike the confirm above** — for the same reason. The confirm tells
     * the customer something this service knows (an appointment now exists); this one would be
     * guessing at an outcome that has not happened yet.
     */
    static pay = asyncHandler(async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as { phone?: unknown };
        sendSuccess(res, await payBooking(String(req.params.handle ?? ''), { phone: body.phone }));
    });
}

/** The session behind the handle, or the one refusal every screen gives for a dead one. */
async function sessionOf<K extends 'bl' | 'bk'>(kind: K, req: Request) {
    const session = await inAppSurfaceStore.read(kind, String(req.params.handle ?? ''));
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, 410, undefined, { kind });
    }
    return session;
}

/**
 * Say in the conversation what just happened.
 *
 * ⚠ **Telegram only, and the WhatsApp half is stated rather than hidden.** A Mini App page is a
 * Telegram control; on WhatsApp these screens are Flows, and a completed Flow comes back through
 * the ordinary reply renderer — which says a deliberately content-free sentence there, because a
 * completion is a fresh inbound whose payload is caller-supplied and must not be echoed. The same
 * split `ticket-form.controller.ts` already carries.
 */
async function pushReceipt(
    channel: string,
    externalId: string,
    language: string | null,
    outcome: BookingConfirmed,
): Promise<void> {
    if (channel !== 'telegram') return;
    try {
        await telegramBotService.sendMessage(
            externalId,
            bookingChatReceipt(
                { moved: outcome.moved, awaitingShop: outcome.awaitingShop },
                { reference: outcome.reference, when: outcome.when, service: outcome.service },
                language,
            ),
            {
                /**
                 * ⚠ **The button and its handler landed together, button last.** `open:bl` is
                 * answered by `BOOKING_ACTION_HANDLERS` in `bot-booking.controller.ts`; drawing
                 * it before that map existed would answer every tap with the unknown-tap
                 * sentence, which on Telegram reaches the customer as silence.
                 *
                 * ⚠ **A tap code, never a link.** The screen it opens resolves the tapping
                 * customer's own session server-side, so the reference and the time are read from
                 * a scope that belongs to them — which is also what lets the WhatsApp half say a
                 * content-free sentence and still be useful.
                 */
                buttons: [{
                    text: botChrome('myBookingsButton', language),
                    callbackData: openSurfaceActionId('bl'),
                }],
            },
        );
    } catch (error) {
        console.error('[BookingScreens] receipt push failed:', error);
    }
}
