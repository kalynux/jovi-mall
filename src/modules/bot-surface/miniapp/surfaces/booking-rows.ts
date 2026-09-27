/**
 * The bookings list's rules, as pure functions — which row comes first, what word it carries, and
 * whether it can be paid.
 *
 * ── WHY THIS IS NOT IN `booking.core.ts` ────────────────────────────────────
 * The core reaches the payment orchestrator, which does work at import time, so a bare `ts-node`
 * suite cannot import it. These rules decide what a customer is offered to pay, and a rule about
 * money that cannot be run in a test is a rule nobody has run. Everything here takes plain data
 * and imports only types and words.
 *
 * ⚠ **`payable` carries NO AMOUNT, deliberately.** It says which of the two charges a Pay control
 * would open; the figure is `bp`'s to resolve, at its read and again at its pay, because a balance
 * moves when the shop settles the appointment.
 */
import type { IBooking } from '../../../booking/models/booking.model';
import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import {
    BOOKING_TEXT_CAPS,
    BookingRowStatus,
    bookingRowStatusLabel,
    fitBookingRowTitle,
} from '../../domain/bot-booking-copy';

export type BookingPayPurpose = 'primary' | 'balance';

/** The fields these rules read, so a test can hand in a plain object. */
export type BookingRowSource = Pick<
    IBooking,
    'status' | 'paymentStatus' | 'requiresPayment' | 'settlement' | 'startAt'
>;

/** What is still owed above the quote once the shop settled the appointment. Never negative. */
function outstandingBalance(booking: BookingRowSource): number {
    return (booking.settlement?.balanceDue ?? 0) - (booking.settlement?.balancePaid ?? 0);
}

/**
 * Which charge a Pay control on this row would open, or null for none.
 *
 * ⚠ **Mirrors the orchestrator's own guards and is narrower than them on purpose.** The price is
 * payable only while `unpaid` or `failed` — the same set the 24-hour sweep reads — so a charge
 * already in flight (`pending`) is not offered a second button, and a refund state never reads as
 * money owed. And only on an appointment the shop has ACCEPTED (`confirmed`, or `completed` and
 * still unpaid): a `manual`-mode service comes back `pending`, and inviting payment for a visit the
 * shop may still decline would need a refund the customer never asked for.
 */
export function bookingPayable(booking: BookingRowSource): BookingPayPurpose | null {
    if (booking.status === 'cancelled' || booking.status === 'no-show') return null;

    if (
        booking.requiresPayment
        && (booking.paymentStatus === 'unpaid' || booking.paymentStatus === 'failed')
        && (booking.status === 'confirmed' || booking.status === 'completed')
    ) {
        return 'primary';
    }

    if (booking.status === 'completed' && outstandingBalance(booking) > 0) return 'balance';
    return null;
}

/**
 * Refuse a charge that has nothing to charge — at the READ of the pay screen and at the tap that
 * opens it, never only at Pay.
 *
 * ⚠ **Why here and not at Pay.** The refusal at Pay costs the `bp` handle (`consume` runs first)
 * and leaves the page latched, so the customer meets a dead screen at the moment of paying.
 * Refused before any button is drawn, it costs nothing and is a sentence they can act on.
 *
 * The codes are the orchestrator's own, so every door refuses one booking with one code.
 */
export function assertSomethingDue(booking: BookingRowSource & { _id?: unknown }, purpose: BookingPayPurpose): void {
    const bookingId = booking._id === undefined ? undefined : String(booking._id);
    if (booking.status === 'cancelled') {
        throw createAppError(ERROR_CODES.PAYMENT_BOOKING_CANCELLED, 400, undefined, { bookingId });
    }
    if (purpose === 'primary') {
        if (!booking.requiresPayment) {
            throw createAppError(ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED, 400, undefined, { bookingId });
        }
        if (booking.paymentStatus === 'paid') {
            throw createAppError(ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID, 409, undefined, { bookingId });
        }
        return;
    }
    if (outstandingBalance(booking) <= 0) {
        throw createAppError(ERROR_CODES.BOOKING_BALANCE_ALREADY_SETTLED, 409, undefined, { bookingId });
    }
}

/**
 * Which charge the list's **Pay** opens for this booking — re-decided at the TAP, from the
 * booking as it is now, never from the row the page was drawn with.
 *
 * ⚠ **A row can be stale**: paid a minute ago, cancelled by the shop, a payment already on its
 * way. So the rule is the list's own (`bookingPayable`) and every "no" is a refusal with a reason:
 * nothing to pay (the orchestrator's codes), a payment already in flight, or owed but not payable
 * YET (a `manual`-mode service the shop has not accepted). The page redraws the list on any of
 * them, so the row shows where it really stands.
 */
export function payPurposeOrRefuse(booking: BookingRowSource & { _id?: unknown }): BookingPayPurpose {
    const payable = bookingPayable(booking);
    if (payable) return payable;

    const bookingId = booking._id === undefined ? undefined : String(booking._id);
    assertSomethingDue(booking, booking.status === 'completed' ? 'balance' : 'primary');
    if (booking.paymentStatus === 'pending') {
        throw createAppError(ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS, 409, undefined, { bookingId });
    }
    throw createAppError(ERROR_CODES.BOOKING_NOT_PAYABLE_NOW, 409, undefined, { bookingId, status: booking.status });
}

/**
 * The codes that mean "nothing to pay here" — what `bp.html` turns into `payNothingDue`.
 * Exported so the suite can assert the page and this list agree.
 */
export const NOTHING_DUE_CODES: readonly string[] = Object.freeze([
    ERROR_CODES.PAYMENT_BOOKING_CANCELLED,
    ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED,
    ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID,
    ERROR_CODES.BOOKING_BALANCE_ALREADY_SETTLED,
]);

export function isNothingDue(error: unknown): boolean {
    return error instanceof AppError && NOTHING_DUE_CODES.includes(error.code);
}

/**
 * The one word a row carries, or null when a live, settled appointment needs none.
 *
 * Order matters: a cancelled appointment is cancelled whatever its payment says, and an unpaid
 * one the shop has not accepted yet is, first of all, not accepted.
 */
export function bookingRowStatus(booking: BookingRowSource, payable: BookingPayPurpose | null): BookingRowStatus | null {
    if (booking.status === 'cancelled') return 'cancelled';
    if (booking.status === 'no-show') return 'missed';
    if (booking.status === 'pending') return 'awaitingShop';
    if (payable === 'primary') return 'unpaid';
    if (payable === 'balance') return 'balanceDue';
    if (booking.status === 'completed') return 'done';
    return null;
}

/**
 * Upcoming first — the NEXT appointment at the top — then the past, most recent first.
 *
 * ⚠ The list used to be `startAt` descending, which put the appointment furthest in the future at
 * the top and buried the one the customer is about to go to.
 */
export function orderUpcomingFirst<T extends { startAt: Date }>(rows: readonly T[], now: Date): T[] {
    const at = now.getTime();
    const upcoming = rows.filter((r) => r.startAt.getTime() >= at)
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const past = rows.filter((r) => r.startAt.getTime() < at)
        .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
    return [...upcoming, ...past];
}

export interface CustomerBookingRow {
    bookingId: string;
    reference: string;
    label: string;
    when: string;
    timezone: string;
    title: string;
    description: string;
    /** The booking's own status, as data. */
    status: string;
    /** The translated word in `description`, or null. */
    statusLabel: string | null;
    payable: BookingPayPurpose | null;
}

export type CustomerBookingSource = BookingRowSource & {
    _id: unknown;
    vendorId: unknown;
    bookingNumber?: string;
    productId?: unknown;
};

/**
 * Rows, as a screen draws them.
 *
 * ⚠ **The shop's timezone is resolved ONCE PER DISTINCT VENDOR**, not once per row: twenty rows
 * from one salon used to be twenty vendor reads per open.
 */
export async function projectCustomerBookings(
    rows: readonly CustomerBookingSource[],
    options: {
        language: string;
        now: Date;
        limit: number;
        timezoneOf: (vendorId: string) => Promise<string>;
        when: (startAt: Date, timezone: string) => string;
    },
): Promise<CustomerBookingRow[]> {
    const zones = new Map<string, Promise<string>>();
    const zoneOf = (vendorId: string): Promise<string> => {
        let zone = zones.get(vendorId);
        if (!zone) {
            zone = options.timezoneOf(vendorId);
            zones.set(vendorId, zone);
        }
        return zone;
    };

    const ordered = orderUpcomingFirst(rows, options.now).slice(0, options.limit);
    const out: CustomerBookingRow[] = [];
    for (const row of ordered) {
        const timezone = await zoneOf(String(row.vendorId));
        const service = (row.productId as { title?: string } | null | undefined)?.title ?? '';
        const when = options.when(row.startAt, timezone);
        const reference = String(row.bookingNumber ?? '');
        const payable = bookingPayable(row);
        const status = bookingRowStatus(row, payable);
        const statusLabel = status ? bookingRowStatusLabel(status, options.language) : null;

        out.push({
            bookingId: String(row._id),
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
            description: [reference, statusLabel].filter(Boolean).join(' · ')
                .slice(0, BOOKING_TEXT_CAPS.rowDescription),
            status: row.status,
            statusLabel,
            payable,
        });
    }
    return out;
}
