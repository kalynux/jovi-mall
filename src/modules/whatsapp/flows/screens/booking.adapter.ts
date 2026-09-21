import type { BookingConfirmed } from '../../../bot-surface/miniapp/surfaces/booking.core';
import { screenResponse, type FlowResponseBody } from '../domain/flow-protocol';
import {
    BOOKING_DAY_SCREEN,
    BOOKING_LIST_SCREEN,
    BOOKING_TIMES_SCREEN,
} from '../definitions/booking.flow';
import type { FlowCopy } from './flow-copy';
import { noticeResponse } from './listing.adapter';
import { FLOW_CAPS, fitText } from './flow-text';

/**
 * Bookings, reshaped for the three booking forms.
 *
 * ── ⚠ RESHAPES, NEVER RE-DERIVES — AND HERE IT HOLDS TWICE OVER ────────────
 * Every value comes from `booking.core.ts`, the same read the Telegram pages call: the day
 * labels, the times, the row titles, the counts, and **the screens' own words**. This file
 * places them. It formats no date, no time, no price and no count — a Flow cannot, and the
 * platform refuses money maths outside the backend, but the stronger reason is that the shop's
 * timezone decides what "14:00" means and only the server knows it.
 *
 * ⚠ **The words come from the READ, not from a copy table of mine.** `readBookingPicker` returns
 * its own `copy`, so the form and the page cannot word one screen differently. The only strings
 * taken from the Flow copy table are the two FOOTER labels, which exist because a Flow screen has
 * a footer button and a web page does not.
 */

/** What the picker read hands back for the day screen. */
export interface BookingDayView {
    moving: string | null;
    copy: { pickDay: string; movingNotice: string; listEmpty: string };
    days: Array<{ date: string; label: string; description: string }>;
}

/** What it hands back for the times screen. */
export interface BookingTimesView {
    copy: { pickTime: string; confirm: string; listEmpty: string };
    label?: string;
    slots: Array<{ slotId: string; label: string; description?: string | null }>;
}

/**
 * The customer's appointments — one screen, one choice, terminal.
 *
 * ⚠ **`title` and `description` arrive already worded and already in the shop's timezone.** The
 * row is placed, never composed.
 */
export function toBookingListScreen(
    rows: ReadonlyArray<{ bookingId: string; title: string; description: string }>,
    words: { listTitle: string; listEmpty: string },
    copy: FlowCopy,
): FlowResponseBody {
    if (rows.length === 0) return noticeResponse(words.listEmpty, copy);

    return screenResponse(BOOKING_LIST_SCREEN, {
        heading: fitText(words.listTitle, FLOW_CAPS.heading),
        bookings: rows.slice(0, FLOW_CAPS.radioOptions).map((row) => ({
            id: row.bookingId,
            title: fitText(row.title, FLOW_CAPS.optionTitle),
            description: fitText(row.description, FLOW_CAPS.optionDescription),
        })),
        chooseLabel: fitText(copy.detailChoose, FLOW_CAPS.inputLabel),
        openLabel: fitText(copy.bookingOpen, FLOW_CAPS.footerLabel),
    });
}

/**
 * Day one of two: which day.
 *
 * ⚠ **Only days that HAVE times are offered**, which is why this screen needs no "nothing that
 * day" path — the read cannot return an empty day. An empty LIST is still possible (a service
 * with no availability at all) and gets the notice screen.
 *
 * ⚠ **A reschedule says so in the HEADING rather than in an extra line**, because Meta documents
 * no way to hide a component: a caption that only sometimes applies would have to be a second
 * screen, and the heading is already a binding the endpoint fills.
 */
export function toBookingDayScreen(view: BookingDayView, copy: FlowCopy): FlowResponseBody {
    if (view.days.length === 0) return noticeResponse(view.copy.listEmpty, copy);

    return screenResponse(BOOKING_DAY_SCREEN, {
        heading: fitText(
            view.moving ? view.copy.movingNotice : view.copy.pickDay,
            FLOW_CAPS.heading,
        ),
        days: view.days.slice(0, FLOW_CAPS.radioOptions).map((day) => ({
            id: day.date,
            title: fitText(day.label, FLOW_CAPS.optionTitle),
            description: fitText(day.description, FLOW_CAPS.optionDescription),
        })),
        chooseLabel: fitText(copy.detailChoose, FLOW_CAPS.inputLabel),
        continueLabel: fitText(copy.bookingSeeTimes, FLOW_CAPS.footerLabel),
    });
}

/**
 * Day two of two: which time.
 *
 * ⚠ **A `Dropdown`, because one day CAN exceed twenty slots** — a fifteen-minute service from
 * nine to five is thirty-two — and a radio group would silently lose the rest. The read caps what
 * it returns below the drop-down's 200, so nothing can overflow what this can draw.
 *
 * ⚠ **The slot id is opaque and is never interpreted here.** A caller-supplied interval priced
 * pro rata is the hole this module was fixed for; `confirmBooking` re-verifies whatever comes
 * back through the same hold every other door uses.
 */
export function toBookingTimesScreen(view: BookingTimesView, copy: FlowCopy): FlowResponseBody {
    if (view.slots.length === 0) return noticeResponse(view.copy.listEmpty, copy);

    return screenResponse(BOOKING_TIMES_SCREEN, {
        dayLine: fitText(view.label ?? '', FLOW_CAPS.caption),
        chooseLabel: fitText(view.copy.pickTime, FLOW_CAPS.inputLabel),
        /**
         * ⚠ **The description line is placed only when the read has something to say.** It is
         * "2 spots left" on a capacity service and **null on a one-person appointment** — null
         * meaning "not a class", never "none left". Coalescing it to a number or to an empty
         * string would tell every haircut customer no seats remain, or draw an empty line under
         * every time. The count sits inside the sentence because "1 spots left" is wrong in all
         * five languages, which is why the wording is the read's and not this file's.
         */
        times: view.slots.slice(0, FLOW_CAPS.dropdownOptions).map((slot) => ({
            id: slot.slotId,
            title: fitText(slot.label, FLOW_CAPS.optionTitle),
            ...(slot.description
                ? { description: fitText(slot.description, FLOW_CAPS.optionDescription) }
                : {}),
        })),
        confirmLabel: fitText(view.copy.confirm, FLOW_CAPS.footerLabel),
    });
}

/**
 * The closing screen after an appointment is made or moved.
 *
 * ── ⚠ THE SCREEN GETS THE FULL RECEIPT; THE CHAT GETS NEITHER ──────────────
 * Here the endpoint has just made the booking and holds its reference, its time and whether the
 * shop still has to accept — so the screen says all of it, which is the last chance to show it
 * while the session is provably this customer's. The CHAT that follows says only that it has the
 * booking, plus a button, because by then the handle is spent and the completion is a fresh
 * caller-supplied inbound. Two sentences, one module, and the reason they differ is written at
 * both ends (`bot-booking-copy.ts`).
 *
 * @param receipt the full sentence, already composed by the booking copy module.
 */
export function bookingConfirmedResponse(
    confirmed: Pick<BookingConfirmed, 'moved'>,
    receipt: string,
    copy: FlowCopy,
): FlowResponseBody {
    return noticeResponse(receipt, copy, confirmed.moved ? 'moved' : 'booked');
}
