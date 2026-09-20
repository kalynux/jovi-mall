import type { InAppSurfaceKind } from '../../../bot-surface/services/inapp-surface.store';
import type { FlowDefinition } from './flow-definition.types';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN, noticeScreen } from './notice.screen';

/**
 * Bookings, as WhatsApp Flows — the ports of the `bl` (list), `bk` (pick a slot) and `bp` (pay)
 * screens.
 *
 * ── ⚠ DRAFTS, AND NOT PUBLISHABLE — TWICE OVER ─────────────────────────────
 * Neither half exists yet: the bookings stream is extracting `readBookingSlots` and
 * `confirmBooking` as this is written, and the three screen KINDS (`bl`, `bk`, `bp`) are not in
 * `InAppSurfaceKind` yet either. So these are **builders that take the kind**, not finished
 * definitions — the day those kinds land, each becomes one exported constant and nothing else
 * changes. `test:whatsapp-flows` instantiates them with a placeholder kind and holds them to
 * every structural rule today, and they are absent from `scripts/publish-whatsapp-flows.ts`,
 * which the suite also asserts: a Flow published before its read exists opens a form that cannot
 * be sent.
 *
 * ── THE ONE RULE THAT SHAPED ALL THREE ──────────────────────────────────────
 * A Flow screen is a FORM, and single choice caps at **20** options as a radio group, 200 as a
 * drop-down. A fortnight of slots is neither — which is why `bk` is two screens (a day, then that
 * day's times) rather than one long list, and why the bookings stream is building its read
 * day-scoped on BOTH channels. That decision was taken before either page was drawn.
 *
 * ── ⚠ NOTHING HERE FORMATS A TIME, A DATE OR A PRICE ───────────────────────
 * A Flow cannot do arithmetic or locale formatting, and this platform refuses money maths outside
 * the backend. Every label below arrives already worded by the read: "Tue 22 Sep · 6 times",
 * "14:00 – 15:00", "12 500 FCFA". The form places words it was given.
 */

/**
 * `bl` — the customer's bookings, one screen, terminal.
 *
 * Choosing one CLOSES the form and hands the choice to the chat, which opens that booking's card.
 * The listing form works the same way and for the same reason: each screen has its own handle with
 * its own kind and lifetime, and one Flow spanning two would need one handle spanning both.
 *
 * ⚠ **Up to 20, and there is no "load more" on a form.** Past that the honest answer is the chat.
 */
export function bookingListFlow(kind: InAppSurfaceKind): FlowDefinition {
    return {
        version: '6.0',
        data_api_version: '3.0',
        routing_model: { BOOKINGS: [], [NOTICE_SCREEN]: [] },
        screens: [
            {
                id: 'BOOKINGS',
                title: FLOW_SCREEN_TITLE,
                terminal: true,
                data: {
                    heading: { type: 'string', __example__: 'Your bookings' },
                    bookings: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                /** ⚠ 30 characters. The reference and the when, already worded. */
                                title: { type: 'string' },
                                /** Service · state · price, already worded. Never a number. */
                                description: { type: 'string' },
                            },
                        },
                        __example__: [
                            {
                                id: '66f1a2b3c4d5e6f708192a60',
                                title: 'BKG-2026-000123 · Tue 14:00',
                                description: 'Coupe homme · Confirmed · 5 000 FCFA',
                            },
                        ],
                    },
                    openLabel: { type: 'string', __example__: 'Open' },
                },
                layout: {
                    type: 'SingleColumnLayout',
                    children: [
                        { type: 'TextHeading', text: '${data.heading}' },
                        {
                            type: 'RadioButtonsGroup',
                            name: 'booking',
                            required: true,
                            'data-source': '${data.bookings}',
                        },
                        {
                            type: 'Footer',
                            label: '${data.openLabel}',
                            'on-click-action': {
                                name: 'complete',
                                payload: { screen: kind, bookingId: '${form.booking}' },
                            },
                        },
                    ],
                },
            },
            noticeScreen(kind),
        ],
    };
}

/**
 * `bk` — booking a slot, in two screens.
 *
 * ── ⚠ WHY TWO, AND WHY NOT A CALENDAR ──────────────────────────────────────
 * Twenty options is the radio cap, so a fortnight cannot be one list. Screen one offers only the
 * days that HAVE availability, each saying what is left ("Tue 22 Sep · 6 times"); screen two
 * offers that day's times.
 *
 * A `CalendarPicker` (with `min-date`/`max-date`) is the familiar alternative and works — an empty
 * day would return to the same screen with a snackbar. The day LIST is drafted instead because it
 * can only ever offer days that have something, so it needs no failure path at all. Switching is a
 * change to this screen and nothing else.
 *
 * ⚠ **The day is CONFIRMED with the footer rather than jumping on selection.** Meta supports an
 * `on-select-action` that exchanges the moment a radio is touched, which would save a tap — and
 * would also move the customer on before they can change their mind about the day. One path, one
 * press.
 *
 * ⚠ **Times are a `Dropdown`, not a radio group**, because a day CAN exceed twenty: nine to five
 * at fifteen-minute granularity is thirty-two slots, and a radio group would silently lose the
 * rest. A drop-down takes 200 and costs one tap to open. (If the bookings stream confirms a day
 * can never exceed twenty, this becomes a radio group and nothing else changes.)
 *
 * ⛔ **The slot id is an opaque handle the read produced, and this side never interprets it.** A
 * caller-supplied interval priced pro rata is exactly the hole that was found on this module; the
 * booking core re-verifies whatever comes back against live availability.
 */
export function bookingSlotFlow(kind: InAppSurfaceKind): FlowDefinition {
    return {
        version: '6.0',
        data_api_version: '3.0',
        routing_model: {
            DAY: ['TIMES', NOTICE_SCREEN],
            TIMES: [NOTICE_SCREEN],
            [NOTICE_SCREEN]: [],
        },
        screens: [
            {
                id: 'DAY',
                title: FLOW_SCREEN_TITLE,
                data: {
                    heading: { type: 'string', __example__: 'When would you like to come?' },
                    days: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                /** The read's own day reference. Never parsed on this side. */
                                id: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                            },
                        },
                        __example__: [
                            { id: '2026-09-22', title: 'Tue 22 Sep', description: '6 times' },
                            { id: '2026-09-23', title: 'Wed 23 Sep', description: '2 times' },
                        ],
                    },
                    continueLabel: { type: 'string', __example__: 'See times' },
                },
                layout: {
                    type: 'SingleColumnLayout',
                    children: [
                        { type: 'TextHeading', text: '${data.heading}' },
                        {
                            type: 'RadioButtonsGroup',
                            name: 'day',
                            required: true,
                            'data-source': '${data.days}',
                        },
                        {
                            type: 'Footer',
                            label: '${data.continueLabel}',
                            /** The endpoint answers with TIMES for that day — or the notice. */
                            'on-click-action': {
                                name: 'data_exchange',
                                payload: { day: '${form.day}' },
                            },
                        },
                    ],
                },
            },
            {
                id: 'TIMES',
                title: FLOW_SCREEN_TITLE,
                data: {
                    /** The day chosen, worded by the read — "Tuesday 22 September". */
                    dayLine: { type: 'string', __example__: 'Tuesday 22 September' },
                    chooseLabel: { type: 'string', __example__: 'Pick a time' },
                    times: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                /** ⛔ The opaque slot handle. Re-verified server-side at confirm. */
                                id: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                            },
                        },
                        __example__: [
                            { id: 'slot_opaque_1', title: '14:00 – 15:00', description: '5 000 FCFA' },
                            { id: 'slot_opaque_2', title: '15:00 – 16:00', description: '5 000 FCFA' },
                        ],
                    },
                    confirmLabel: { type: 'string', __example__: 'Confirm' },
                },
                layout: {
                    type: 'SingleColumnLayout',
                    children: [
                        { type: 'TextCaption', text: '${data.dayLine}' },
                        {
                            type: 'Dropdown',
                            name: 'slot',
                            label: '${data.chooseLabel}',
                            required: true,
                            'data-source': '${data.times}',
                        },
                        {
                            type: 'Footer',
                            label: '${data.confirmLabel}',
                            'on-click-action': {
                                name: 'data_exchange',
                                payload: { slotId: '${form.slot}' },
                            },
                        },
                    ],
                },
            },
            noticeScreen(kind),
        ],
    };
}

/**
 * `bp` — paying for a booking. The checkout's shape, for the checkout's reasons.
 *
 * ⚠ **It holds no amount.** The figure is re-resolved when the screen is drawn and again when Pay
 * is pressed; a held total is a total that can disagree with the booking by the time somebody
 * pays. Nothing on this screen is computed here.
 *
 * ⚠ **One input, and it is a phone number**, with the masked number on file as its helper text and
 * empty meaning "use that one" — the same disclosure rule the checkout screen follows.
 *
 * ⚠ **The result does not come back here.** No form can hold a session open while a mobile-money
 * push is approved on a handset, so this closes with "approve it on your phone, I'll tell you in
 * the chat" and the payment path delivers the outcome.
 */
export function bookingPayFlow(kind: InAppSurfaceKind): FlowDefinition {
    return {
        version: '6.0',
        data_api_version: '3.0',
        routing_model: { PAY: [NOTICE_SCREEN], [NOTICE_SCREEN]: [] },
        screens: [
            {
                id: 'PAY',
                title: FLOW_SCREEN_TITLE,
                data: {
                    totalText: { type: 'string', __example__: 'To pay: 5 000 FCFA' },
                    /** What it is for — service, day and time — as one string the read worded. */
                    bookingLine: {
                        type: 'string',
                        __example__: 'Coupe homme · Tuesday 22 September, 14:00',
                    },
                    phoneLabel: { type: 'string', __example__: 'Mobile money number' },
                    phoneHint: {
                        type: 'string',
                        __example__: 'Leave this empty to use the number on your account. If you type one, include the country code, for example +237.',
                    },
                    /** ⚠ Masked upstream, shown verbatim, never re-masked. Empty when none. */
                    phoneMasked: { type: 'string', __example__: '+2376••••4417' },
                    payLabel: { type: 'string', __example__: 'Pay now' },
                },
                layout: {
                    type: 'SingleColumnLayout',
                    children: [
                        { type: 'TextHeading', text: '${data.totalText}' },
                        { type: 'TextBody', text: '${data.bookingLine}' },
                        { type: 'TextCaption', text: '${data.phoneHint}' },
                        {
                            type: 'TextInput',
                            name: 'phone',
                            'input-type': 'phone',
                            required: false,
                            label: '${data.phoneLabel}',
                            'helper-text': '${data.phoneMasked}',
                        },
                        {
                            type: 'Footer',
                            label: '${data.payLabel}',
                            'on-click-action': {
                                name: 'data_exchange',
                                payload: { phone: '${form.phone}' },
                            },
                        },
                    ],
                },
            },
            noticeScreen(kind),
        ],
    };
}
