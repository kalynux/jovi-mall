/**
 * The booking screens' READS and WRITE, with no transport around them.
 *
 * ── WHY THIS IS NOT IN THE CONTROLLER ───────────────────────────────────────
 * Three surfaces project the same booking data: the Telegram page, the WhatsApp form and the
 * chat. The first two must agree exactly — one read, one set of rules, two renderings — and the
 * WhatsApp side cannot import `bot-booking.controller.ts` at all: that file reaches the booking
 * and payment services, which do work at import time, so a bare `ts-node` suite importing it
 * produces no output and reads as a broken test rather than a hanging one.
 *
 * So everything here takes plain arguments, returns plain data, throws `AppError` for refusals,
 * and imports no Express and no controller.
 *
 * ── WHY THE READS ARE DAY-SCOPED ────────────────────────────────────────────
 * A WhatsApp form is a FORM: a single-choice list caps at 20 options (200 in a dropdown), so a
 * fortnight of slots cannot be drawn on one screen at all. The screen is therefore two steps —
 * a day, then that day's times — and these reads mirror it. The Telegram page asks the same two
 * questions, so neither channel pages a list the other cannot show.
 *
 * ⚠ **The labels are produced HERE, in words, and that is deliberate.** A form can place text
 * but cannot format a time, a date or a price, and this platform refuses money arithmetic
 * outside the backend. Anything a screen displays is a string this module returns.
 *
 * ⚠ **Days and times are the SHOP's wall clock, never the server's and never the viewer's.**
 * Availability rules are authored in the vendor's timezone and the vendor's calendar is what is
 * being filled, so a slot that reads "14:00" must be 14:00 where the appointment happens. This
 * is the same rule `BookingService.getCalendarView` states, and the same fallback.
 *
 * ⚠ **Month names appear here, unlike in notification copy.** `formatMoment` deliberately sends
 * `yyyy-MM-dd HH:mm` into messages — locale-neutral, nothing to translate, no day/month
 * ambiguity. A picker is the opposite case: it is a list somebody chooses from, and
 * "2026-09-22 14:00" as one of twenty rows is unreadable. `Intl` localises these in all five
 * languages, and they are screen labels rather than approved template text, so nothing is frozen
 * by them.
 */
import { Types } from 'mongoose';
import { productBookingService } from '../../../catalog/domain/services/booking/product-booking.instance';
import { BookingService } from '../../../booking/services/booking.service';
import { Booking, IBooking } from '../../../booking/models/booking.model';
import { ProductModel } from '../../../catalog/models';
import { VendorModel } from '../../../vendors/vendor.model';
import { BOOKING_CONFIG } from '../../../booking/config/booking.config';
import { inAppSurfaceStore } from '../../services/inapp-surface.store';
import { CustomerModel, ICustomer } from '../../../customers/customer.model';
import { PaymentOrchestratorService } from '../../../payments/services/payment-orchestrator.service';
import {
    assertNetworkChargeable,
    maskedPayerNumber,
    mobileMoneyGateway,
    storedPayerNumber,
    validatedPayerNumber,
} from './checkout-payer';
import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import type { Slot } from '../../../booking/types/booking.types';
import {
    BOOKING_TEXT_CAPS,
    bookingScreenCopy,
    bookingSpotsLeft,
    bookingTimesAvailable,
    fitBookingRowTitle,
} from '../../domain/bot-booking-copy';

/**
 * ⚠ **Its own instance, exactly as every other door holds one** (`bot-booking.controller.ts`,
 * the customer controller and the vendor controller each do `new BookingService()`). The class
 * holds no per-request state; there is no shared instance to import.
 */
const bookingService = new BookingService();
const paymentOrchestrator = new PaymentOrchestratorService();

/** The five the bot speaks. Anything else falls back to English, as every other surface does. */
type ScreenLanguage = 'en' | 'fr' | 'pt' | 'es' | 'ar';

const LOCALE: Readonly<Record<ScreenLanguage, string>> = Object.freeze({
    en: 'en-GB',
    fr: 'fr-FR',
    pt: 'pt-PT',
    es: 'es-ES',
    ar: 'ar',
});

const languageOf = (language: string | null | undefined): ScreenLanguage =>
    (['en', 'fr', 'pt', 'es', 'ar'] as const).includes(language as ScreenLanguage)
        ? (language as ScreenLanguage)
        : 'en';

/**
 * How far ahead a picker looks, and how much of it a screen may hold.
 *
 * ⚠ **`MAX_DAYS` is 20 because a WhatsApp radio list caps at 20**, and `MAX_SLOTS_PER_DAY` is
 * 200 for the dropdown's cap. They are ceilings, not targets: a shop open six days a week fills
 * about three weeks of the first, and only a service sold in very short slots approaches the
 * second. A cap here is what stops a screen being built that cannot be drawn.
 */
export const BOOKING_PICKER_LIMITS = Object.freeze({
    horizonDays: 21,
    maxDays: 20,
    maxSlotsPerDay: 200,
});

export interface BookingDayOption {
    /** `YYYY-MM-DD` on the SHOP's wall clock. The argument `readBookingSlots` takes back. */
    date: string;
    /** What the screen shows, e.g. "Tue 22 Sep". */
    label: string;
    /** How many times are free that day — the screen's description line. */
    slotCount: number;
}

export interface BookingSlotOption {
    /** Opaque. Echoed back to `confirmBooking`, which re-verifies it. */
    slotId: string;
    /** What the screen shows, e.g. "14:00 – 15:00". */
    label: string;
    /** Capacity services only; null on a one-person appointment — not "none left". */
    spotsRemaining: number | null;
    /**
     * The row's description, e.g. "2 spots left", or null when there is nothing to say.
     *
     * ⚠ **Worded here because a form cannot build a sentence**, and null rather than "0 spots
     * left" on a one-person appointment: `spotsRemaining: null` means "not a class", and a
     * transport turning that into a number would tell every haircut customer no seats remain.
     */
    description: string | null;
}

/** The shop's wall clock — the one availability was authored in. */
async function shopTimezone(vendorId: unknown): Promise<string> {
    const vendor = await VendorModel.findById(String(vendorId)).select('timezone').lean();
    return (vendor as { timezone?: string } | null)?.timezone || BOOKING_CONFIG.defaultTimezone;
}

/**
 * The product's shop, and its clock — resolved once per read.
 *
 * ⚠ Throws the same 404 the availability read does for a product that is not bookable, so a
 * screen and the chat refuse an unknown product identically.
 */
async function shopOf(productId: string): Promise<{ vendorId: string; timezone: string }> {
    const product = Types.ObjectId.isValid(productId)
        ? await ProductModel.findById(productId).select('vendorId').lean()
        : null;
    if (!product) {
        throw createAppError(ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND, 404, undefined, {
            productId,
        });
    }
    const vendorId = String((product as { vendorId: unknown }).vendorId);
    return { vendorId, timezone: await shopTimezone(vendorId) };
}

const dayKey = (at: Date, timezone: string): string =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(at);

const dayLabel = (at: Date, timezone: string, language: ScreenLanguage): string =>
    new Intl.DateTimeFormat(LOCALE[language], {
        timeZone: timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
    }).format(at);

const timeLabel = (at: Date, timezone: string, language: ScreenLanguage): string =>
    new Intl.DateTimeFormat(LOCALE[language], {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(at);

/**
 * The days this service actually has times on — never a calendar of empty days.
 *
 * ⚠ **Only days with availability are returned**, which is why no screen here needs an
 * "unfortunately nothing that day" path: a customer can only choose a day that has something.
 * A date picker would need that path; this does not.
 */
export async function readBookingDays(input: {
    productId: string;
    language?: string | null;
    /** Defaults to now. Present so a test can ask about a fixed week. */
    from?: Date;
}): Promise<{ productId: string; timezone: string; days: BookingDayOption[] }> {
    const language = languageOf(input.language);
    const { timezone } = await shopOf(input.productId);

    const from = input.from ?? new Date();
    const to = new Date(from.getTime() + BOOKING_PICKER_LIMITS.horizonDays * 24 * 60 * 60 * 1000);
    const slots = await productBookingService.getAvailability(input.productId, from, to);

    const byDay = new Map<string, { at: Date; count: number }>();
    for (const slot of slots) {
        const key = dayKey(slot.start, timezone);
        const seen = byDay.get(key);
        if (seen) seen.count += 1;
        else byDay.set(key, { at: slot.start, count: 1 });
    }

    const days = [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, BOOKING_PICKER_LIMITS.maxDays)
        .map(([date, { at, count }]) => ({
            date,
            label: dayLabel(at, timezone, language),
            slotCount: count,
        }));

    return { productId: input.productId, timezone, days };
}

/**
 * One day's free times, as a screen can draw them.
 *
 * ⚠ **The day is read on the SHOP's clock, not by slicing UTC.** A day boundary in Douala is not
 * a day boundary in UTC, and a service running to 23:00 would otherwise lose its last hour to
 * the next day — or gain one from the previous.
 */
export async function readBookingSlots(input: {
    productId: string;
    /** `YYYY-MM-DD`, as `readBookingDays` returned it. */
    date: string;
    language?: string | null;
}): Promise<{ productId: string; date: string; label: string; timezone: string; slots: BookingSlotOption[] }> {
    const language = languageOf(input.language);
    const { timezone } = await shopOf(input.productId);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'A day must be YYYY-MM-DD', {
            date: input.date,
        });
    }

    /**
     * Asked over a window WIDER than the day and then filtered by the day key, rather than
     * computing that day's exact instants: the same grouping the days read used, so the two
     * cannot disagree about which slot belongs to which day.
     */
    const midnightish = new Date(`${input.date}T00:00:00Z`);
    const from = new Date(midnightish.getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(midnightish.getTime() + 2 * 24 * 60 * 60 * 1000);
    const all = await productBookingService.getAvailability(input.productId, from, to);
    const ofDay = all.filter((slot: Slot) => dayKey(slot.start, timezone) === input.date);

    return {
        productId: input.productId,
        date: input.date,
        label: ofDay.length > 0 ? dayLabel(ofDay[0].start, timezone, language) : input.date,
        timezone,
        slots: ofDay.slice(0, BOOKING_PICKER_LIMITS.maxSlotsPerDay).map((slot) => ({
            slotId: slot.id,
            label: `${timeLabel(slot.start, timezone, language)} – ${timeLabel(slot.end, timezone, language)}`,
            spotsRemaining: slot.spotsRemaining ?? null,
            description: slot.spotsRemaining === undefined || slot.spotsRemaining === null
                ? null
                : bookingSpotsLeft(slot.spotsRemaining, input.language),
        })),
    };
}

/**
 * ONE call behind the `bk` screen, for whichever transport is drawing it.
 *
 * ── WHY THE HANDLE, RATHER THAN A PRODUCT ID ────────────────────────────────
 * The screen has to know whether it is MAKING an appointment or MOVING one, and only the session
 * knows that — it is the thing the tap minted, and it is not in anything the form or the page
 * sends. Having each transport read the session and assemble this itself is how the Telegram page
 * and the WhatsApp form end up disagreeing about the same screen.
 *
 * Without `date` it answers the days that have times; with it, that day's times. Both carry the
 * screen's own words, so no caller holds a string.
 */
export async function readBookingPicker(
    handle: string,
    input: { date?: string | null } = {},
): Promise<{
    moving: string | null;
    copy: ReturnType<typeof bookingScreenCopy>;
    timezone: string;
    days?: Array<BookingDayOption & { description: string }>;
    date?: string;
    label?: string;
    slots?: BookingSlotOption[];
}> {
    const session = await inAppSurfaceStore.read('bk', handle);
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, 410, undefined, { kind: 'bk' });
    }

    const copy = bookingScreenCopy(session.language);
    const moving = session.bookingId;

    if (input.date) {
        const times = await readBookingSlots({
            productId: session.productId,
            date: input.date,
            language: session.language,
        });
        return { moving, copy, timezone: times.timezone, date: times.date, label: times.label, slots: times.slots };
    }

    const days = await readBookingDays({
        productId: session.productId,
        language: session.language,
    });
    return {
        moving,
        copy,
        timezone: days.timezone,
        days: days.days.map((day) => ({
            ...day,
            /** "6 times free" — the row's description, built here because a form cannot count. */
            description: bookingTimesAvailable(day.slotCount, session.language),
        })),
    };
}

/**
 * Take the chosen time: book it, or move the booking the session names.
 *
 * ⚠ **The handle is SPENT here** (`consume`, not `read`), so a double press cannot open two
 * appointments — the rule the checkout screen already follows for the same reason.
 *
 * ⚠ **The slot is re-verified against live availability, and not by this function.** Both paths
 * below reach `assertOfferedSlot`: the hold does it for a new booking, and the customer branch of
 * `assertRescheduleTarget` does it for a move. That is the point — a form hands back whatever it
 * likes, and the rule that decides is the one every other door uses. A slot id is caller-supplied
 * data, and pricing it without that check is the hole this module must never reopen.
 *
 * ⚠ **The hold is released on every failure**, unlike the customer API, which releases only after
 * its transaction commits and so leaves a dead hold sitting on a slot for fifteen minutes.
 */
export interface BookingConfirmed {
    bookingId: string;
    productId: string;
    /** True when this moved an existing appointment rather than making a new one. */
    moved: boolean;
    /** `BKG-2026-000123` where the booking has one. */
    reference: string;
    /** "Tue 22 Sep 14:00" — localised, in the SHOP's timezone. */
    when: string;
    service: string;
    /**
     * ⚠ A `manual`-mode service comes back `pending`: an appointment the shop has not accepted.
     * Every surface must say so rather than saying "booked" — see `bot-booking-copy.ts`.
     */
    awaitingShop: boolean;
}

export async function confirmBooking(
    handle: string,
    input: { slotId: string; notes?: string | null },
): Promise<BookingConfirmed> {
    const session = await inAppSurfaceStore.consume('bk', handle);
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, 410, undefined, {
            kind: 'bk',
        });
    }

    const { productId, bookingId } = session;
    const held = await productBookingService.lockSlot(productId, input.slotId, session.owner);
    if (!held) {
        throw createAppError(ERROR_CODES.BOOKING_SLOT_LOCKED, 409, undefined, {
            slotId: input.slotId,
        });
    }

    try {
        if (bookingId) {
            const moved = await bookingService.rescheduleBooking(
                bookingId,
                input.slotId,
                session.owner,
                { role: 'customer', id: session.owner },
            );
            return receiptFor(moved, productId, true, languageOf(session.language));
        }

        const created = await productBookingService.bookProduct(
            productId,
            input.slotId,
            session.owner,
            session.owner,
            input.notes ? { notes: input.notes } : undefined,
        );
        return receiptFor(created.booking, productId, false, languageOf(session.language));
    } catch (error) {
        try {
            await productBookingService.unlockSlot(productId, input.slotId, session.owner);
        } catch {
            // The TTL is the backstop; the original refusal is what the caller needs.
        }
        throw error;
    }
}

/**
 * What every surface says about a booking that has just been taken or moved.
 *
 * ⚠ **Built once, here**, so the Telegram page, the WhatsApp form and the chat quote the same
 * time in the same timezone. `pending` is reported as `awaitingShop` rather than as a status
 * word: a raw status is a platform word, and the one thing this must never do is call an
 * unaccepted appointment "booked".
 */
async function receiptFor(
    booking: IBooking,
    productId: string,
    moved: boolean,
    language: ScreenLanguage,
): Promise<BookingConfirmed> {
    const timezone = await shopTimezone(booking.vendorId);
    const product = await ProductModel.findById(productId).select('title').lean();

    return {
        bookingId: String(booking._id),
        productId,
        moved,
        reference: booking.bookingNumber ?? String(booking._id),
        when: `${dayLabel(booking.startAt, timezone, language)} ${timeLabel(booking.startAt, timezone, language)}`,
        service: (product as { title?: string } | null)?.title ?? '',
        awaitingShop: booking.status === 'pending',
    };
}

/**
 * What the `bp` screen shows before anybody pays.
 *
 * ⚠ **THE AMOUNT IS RE-RESOLVED HERE AND HELD NOWHERE.** The session carries a booking id and a
 * purpose, never a figure: a held amount is an amount that can disagree with what is actually
 * charged a minute later, and on a screen that takes money that disagreement is the customer's
 * money. `bp`'s ten-minute life is checkout's, for checkout's reason — it is a credential that
 * moves money, not a list somebody is scrolling.
 *
 * ⚠ **The masked number is the only form of it this side of the server.** `storedPayerNumber`
 * returns the number in full and must never reach a page; `maskedPayerNumber` is what a customer
 * sees, so they can recognise their own wallet without the page holding it.
 */
export async function readBookingPayment(handle: string): Promise<{
    copy: ReturnType<typeof bookingScreenCopy>;
    purpose: 'primary' | 'balance';
    service: string;
    when: string;
    currency: string;
    amount: number;
    amountText: string;
    maskedPayer: string | null;
}> {
    const session = await inAppSurfaceStore.read('bp', handle);
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, 410, undefined, { kind: 'bp' });
    }

    const { booking, customer } = await payableBooking(session.bookingId, session.owner);
    const language = languageOf(session.language);
    const timezone = await shopTimezone(booking.vendorId);
    const product = await ProductModel.findById(booking.productId).select('title').lean();
    const amount = amountDueFor(booking, session.purpose);

    return {
        copy: bookingScreenCopy(session.language),
        purpose: session.purpose,
        service: (product as { title?: string } | null)?.title ?? '',
        when: `${dayLabel(booking.startAt, timezone, language)} ${timeLabel(booking.startAt, timezone, language)}`,
        currency: booking.currency,
        amount,
        amountText: `${booking.currency} ${new Intl.NumberFormat('en-US').format(Math.round(amount))}`,
        maskedPayer: await maskedPayerNumber(customer),
    };
}

/**
 * Take the payment: the appointment's price, or the balance a longer job came to.
 *
 * ── ⚠ EVERY PROTECTION HERE IS THE CHECKOUT'S, COPIED RATHER THAN RE-DERIVED ─
 * The handle is SPENT by this write, the gateway is chosen by the server and never by the page,
 * the network is checked BEFORE the spend for a typed number and after it for the account's, and
 * every refusal carries `details.spent` so the page knows whether its button may unlatch. That
 * flag is read as ABSENT-MEANS-SPENT, because the error boundary strips `details` from internal
 * and gateway failures and a lost response has no body at all — so both stay latched, which is
 * the direction that cannot take a second payment.
 *
 * ⚠ **The result does NOT come back here.** A mobile-money charge is approved on a handset, and
 * no screen can hold a session open while that happens. The customer is told in the chat by the
 * payment path (`payment.received.*` / `payment.failed`), which is also what makes the same
 * answer arrive whether they paid from a screen, from the chat, or from the storefront.
 */
export async function payBooking(
    handle: string,
    input: { phone?: unknown },
): Promise<{ transactionId: string; status: string; instructions?: unknown }> {
    const typed = validatedPayerNumber(input.phone);
    const gateway = mobileMoneyGateway();
    /** Before the spend: a number no network can be resolved for must not cost the handle. */
    if (typed) assertNetworkChargeable(gateway, typed, false);

    const session = await inAppSurfaceStore.consume('bp', handle);
    if (!session) {
        throw createAppError(ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED, 410, undefined, { kind: 'bp' });
    }

    try {
        const { booking, customer } = await payableBooking(session.bookingId, session.owner);
        const payerNumber = typed ?? (await storedPayerNumber(customer));
        if (!payerNumber) {
            throw createAppError(
                ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED,
                422,
                'A mobile money number is needed to take this payment',
                { spent: true },
            );
        }
        /** After the spend, because the account's number needs the session to find the customer. */
        assertNetworkChargeable(gateway, payerNumber, true);

        const channel = { phoneNumber: payerNumber };
        const result = session.purpose === 'balance'
            ? await paymentOrchestrator.initiateBookingBalancePayment(String(booking._id), gateway, channel)
            : await paymentOrchestrator.initiateBookingPayment(String(booking._id), gateway, channel);

        return {
            transactionId: result.transactionId,
            status: result.status,
            instructions: result.instructions,
        };
    } catch (error) {
        throw markSpent(error);
    }
}

/**
 * The booking this screen may charge for, scoped to the customer whose session it is.
 *
 * ⚠ **Scoped in the QUERY**, so another customer's booking id is a 404 rather than a 403 — a 403
 * would confirm the booking exists, which is itself the disclosure.
 */
async function payableBooking(
    bookingId: string,
    owner: string,
): Promise<{ booking: IBooking; customer: ICustomer }> {
    const booking = await Booking.findOne({
        _id: bookingId,
        userId: new Types.ObjectId(owner),
        deletedAt: null,
    });
    if (!booking) {
        throw createAppError(ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND, 404, undefined, { bookingId });
    }

    const customer = await CustomerModel.findOne({ user_id: new Types.ObjectId(owner) });
    if (!customer) {
        throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
    }
    return { booking, customer };
}

/**
 * What is owed right now — the quote, or what a longer job came to above it.
 *
 * ⚠ **Read from the booking at the moment it is asked**, never from the session. The balance in
 * particular moves: a vendor settles the appointment after it happens, and a screen opened before
 * that would otherwise quote a figure that no longer exists.
 */
function amountDueFor(booking: IBooking, purpose: 'primary' | 'balance'): number {
    if (purpose !== 'balance') return booking.priceSnapshot;

    const settlement = booking.settlement;
    const outstanding = (settlement?.balanceDue ?? 0) - (settlement?.balancePaid ?? 0);
    if (outstanding <= 0) {
        throw createAppError(ERROR_CODES.BOOKING_BALANCE_ALREADY_SETTLED, 409, undefined, {
            bookingId: String(booking._id),
        });
    }
    return outstanding;
}

/**
 * Mark a refusal as having cost the handle.
 *
 * ⚠ **Everything after `consume` is spent, whatever went wrong.** A page told otherwise would
 * offer a Pay button backed by a handle that no longer exists — and the customer would meet a
 * dead screen at the one moment they are trying to pay. Copied from the checkout's `markedSpent`
 * rather than re-derived, and it never overwrites a flag a refusal set for itself.
 */
function markSpent(error: unknown): unknown {
    if (!(error instanceof AppError)) return error;
    if (error.details?.spent === true) return error;
    return new AppError(
        error.message,
        error.statusCode,
        error.code,
        error.isOperational,
        { ...(error.details ?? {}), spent: true },
    );
}

/**
 * This customer's appointments, for the bookings list screen.
 *
 * ⚠ **Every word is formatted here**, including the time, so the Telegram page and the WhatsApp
 * form show the same row — the form cannot compute one and the page must not invent another.
 */
export async function readCustomerBookings(input: {
    userId: string;
    language?: string | null;
    limit?: number;
}): Promise<{ bookings: Array<{ bookingId: string; reference: string; label: string; when: string; timezone: string; title: string; description: string }> }> {
    const language = languageOf(input.language);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);

    const rows = await Booking.find({
        userId: new Types.ObjectId(input.userId),
        deletedAt: null,
    })
        .sort({ startAt: -1 })
        .limit(limit)
        .populate<{ productId: { title?: string } }>('productId', 'title')
        .lean();

    const bookings = [];
    for (const row of rows) {
        const timezone = await shopTimezone((row as { vendorId: unknown }).vendorId);
        const startAt = (row as { startAt: Date }).startAt;
        const service = (row as { productId?: { title?: string } }).productId?.title ?? '';
        const when = `${dayLabel(startAt, timezone, language)} ${timeLabel(startAt, timezone, language)}`;
        const reference = String((row as { bookingNumber?: string })?.bookingNumber ?? '');

        bookings.push({
            bookingId: String((row as { _id: unknown })._id),
            reference,
            label: service,
            when,
            timezone,
            /**
             * ⚠ **The row's own title, with the TIME kept whole.** Two appointments for the same
             * service differ by nothing but their time, so a title cut before it renders two
             * identical rows — in the longer languages first. `fitBookingRowTitle` shortens the
             * service instead.
             */
            title: fitBookingRowTitle(service, when),
            description: reference.slice(0, BOOKING_TEXT_CAPS.rowDescription),
        });
    }
    return { bookings };
}
