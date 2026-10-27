/**
 * Where an appointment happens, and what the customer is told about getting in.
 *
 * Plan and owner decisions: `PRODUCTION-READINESS/APPOINTMENT-LOCATION-AND-ACCESS-PLAN.md`.
 *
 * ── Two halves, two lifetimes ────────────────────────────────────────────────
 * - **The service** carries the vendor's SETTING: one place (`ServiceLocationSetting`) and the
 *   default access details (`AppointmentAccessSetting`).
 * - **The booking** carries a COPY made when it was booked (`BookingLocationSnapshot`,
 *   `AppointmentAccessSetting`). The vendor later editing the service, or deleting the
 *   address, must not move or strip an appointment that already exists.
 *
 * ── The gate is computed on READ, and that is the whole mechanism ────────────
 * No job opens anything (owner decision D-7). `computeAppointmentAccess` is called each time a
 * customer reads a booking, compares the clock with the start time minus the vendor's margin,
 * and the link and instructions are **left out of the response** until it says `open` — not
 * sent and hidden, but never sent. One function, so the website, the bot and the mini-app
 * cannot hold three opinions about the same booking at the same instant.
 *
 * Pure: no I/O, `now` injectable, so `test:appointment-access` can pin every boundary.
 */

import { BookingStatus } from '../types/booking.types';

export const APPOINTMENT_LOCATION_KINDS = ['vendor_address', 'customer_address', 'online'] as const;
export type AppointmentLocationKind = (typeof APPOINTMENT_LOCATION_KINDS)[number];

export const APPOINTMENT_LIMITS = Object.freeze({
    instructionsMax: 2000,
    meetingUrlMax: 500,
    /** D-10: the vendor sets the margin; 0 (at the start) to one day before. */
    revealMinutesMax: 1440,
    revealMinutesDefault: 30,
    /** D-4: the link stays readable for one hour after the appointment ends, then closes. */
    graceAfterEndMinutes: 60,
});

/** The vendor's choice of place, on the service. One per service (D-2). */
export interface ServiceLocationSetting {
    kind: AppointmentLocationKind;
    /** One of `vendor.business_addresses[]._id`. Required for `vendor_address`, else null. */
    vendorAddressId: string | null;
}

/** Access details — the service's defaults, and each booking's own copy (D-5). */
export interface AppointmentAccessSetting {
    instructions: string | null;
    meetingUrl: string | null;
    revealMinutesBefore: number;
}

/** The address an appointment was booked at, frozen at booking time. */
export interface BookingLocationSnapshot {
    kind: AppointmentLocationKind;
    /** The address's own name ("Main salon", "Home"). Null for `online`. */
    label: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    /** Formatted line and point when the source address was geocoded; null on legacy text-only ones. */
    formattedAddress: string | null;
    coordinates: [number, number] | null;
    /** The `business_addresses` / `saved_addresses` entry it was copied from — a trace, never re-read. */
    sourceAddressId: string | null;
}

/**
 * A meeting link must be an absolute `https:` URL.
 *
 * ⚠ **`https:` only, never a scheme allowlist with `http:` in it**, and never anything a browser
 * would execute. The link is rendered as a tappable anchor on the customer's screen, so a
 * `javascript:` or `data:` value from a vendor would be script running in the customer's
 * session. Parsed with `URL` rather than matched with a pattern, so `https://evil` hidden
 * behind whitespace or a different scheme in mixed case cannot pass.
 */
export function isAcceptableMeetingUrl(value: string): boolean {
    if (value.length === 0 || value.length > APPOINTMENT_LIMITS.meetingUrlMax) return false;
    if (value !== value.trim()) return false;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
}

/** The access details a service starts with when the vendor has set none. */
export function defaultAccessSetting(): AppointmentAccessSetting {
    return { instructions: null, meetingUrl: null, revealMinutesBefore: APPOINTMENT_LIMITS.revealMinutesDefault };
}

export interface AppointmentSettingsPatch {
    location?: ServiceLocationSetting;
    access?: { instructions?: string | null; meetingUrl?: string | null; revealMinutesBefore?: number };
}

/**
 * Apply a patch to access details: an omitted field is KEPT, `null` clears it.
 *
 * ⛔ **Every write path that rebuilds `serviceConfig` must call this.** The variant repository
 * `$set`s `serviceConfig` whole, and both update paths in `vendor-variant.controller.ts` build
 * the object field by field — a path that forgets these two fields silently deletes the place
 * and the link on the next price edit. `test:appointment-access` scans for it.
 */
export function mergeAccessSetting(
    existing: AppointmentAccessSetting | null | undefined,
    patch: AppointmentSettingsPatch['access'] | undefined,
): AppointmentAccessSetting | undefined {
    if (!patch) return existing ?? undefined;
    const base = existing ?? defaultAccessSetting();
    return {
        instructions: patch.instructions !== undefined ? patch.instructions : base.instructions,
        meetingUrl: patch.meetingUrl !== undefined ? patch.meetingUrl : base.meetingUrl,
        revealMinutesBefore: patch.revealMinutesBefore ?? base.revealMinutesBefore,
    };
}

/** The two appointment fields of a merged `serviceConfig`. Location is replaced whole when given. */
export function mergeAppointmentSettings(
    existing: { location?: ServiceLocationSetting; access?: AppointmentAccessSetting } | null | undefined,
    patch: AppointmentSettingsPatch,
): { location?: ServiceLocationSetting; access?: AppointmentAccessSetting } {
    return {
        location: patch.location ?? existing?.location,
        access: mergeAccessSetting(existing?.access, patch.access),
    };
}

// ─── The gate ────────────────────────────────────────────────────────────────

export type AppointmentAccessState = 'locked' | 'open' | 'closed';

/**
 * Why a gate is shut, so a screen can say something true:
 * - `not_confirmed` — the vendor has not accepted the booking yet;
 * - `not_paid`      — D-3: only a PAID appointment opens, online or cash the vendor marked paid;
 * - `too_early`     — before `opensAt`;
 * - `ended`         — past `closesAt`, or the booking is cancelled / completed / a no-show.
 */
export type AppointmentAccessReason = 'not_confirmed' | 'not_paid' | 'too_early' | 'ended';

export interface AppointmentAccessView {
    state: AppointmentAccessState;
    reason: AppointmentAccessReason | null;
    opensAt: Date;
    closesAt: Date;
    /** True when the vendor has written instructions — said even while locked, the text is not. */
    hasInstructions: boolean;
    /** True when there is a link to come — said even while locked, the link is not. */
    hasMeetingUrl: boolean;
    /** ⚠ PRESENT ONLY WHEN `state === 'open'`. Absent, not null, otherwise. */
    instructions?: string;
    /** ⚠ PRESENT ONLY WHEN `state === 'open'`. Absent, not null, otherwise. */
    meetingUrl?: string;
}

export interface AccessGateBooking {
    status: BookingStatus | string;
    paymentStatus: string;
    requiresPayment: boolean;
    startAt: Date;
    endAt: Date;
    access?: AppointmentAccessSetting | null;
}

/**
 * What the customer may see of a booking's access details right now.
 *
 * `null` when the booking carries no access details at all (booked before this feature, or the
 * vendor set none and the service is not online) — there is nothing to gate, so there is no
 * block to render.
 *
 * Opens only when ALL hold:
 * 1. the booking is `confirmed`;
 * 2. it is paid — `paid`, or it never needed paying (D-3: an unpaid cash booking stays locked
 *    until the vendor marks the cash received);
 * 3. `startAt − revealMinutesBefore ≤ now ≤ endAt + grace`.
 *
 * ⚠ The order of the checks decides the `reason`, and it runs from "most permanent" to "will
 * pass by itself": an ended booking says `ended` even if it was also unpaid, and an unpaid one
 * says `not_paid` even when it is also too early — paying is something the customer can act on,
 * waiting is not.
 */
export function computeAppointmentAccess(
    booking: AccessGateBooking,
    now: Date = new Date(),
): AppointmentAccessView | null {
    const access = booking.access;
    if (!access) return null;
    const hasInstructions = !!access.instructions;
    const hasMeetingUrl = !!access.meetingUrl;
    if (!hasInstructions && !hasMeetingUrl) return null;

    const margin = clampReveal(access.revealMinutesBefore);
    const opensAt = new Date(booking.startAt.getTime() - margin * 60_000);
    const closesAt = new Date(booking.endAt.getTime() + APPOINTMENT_LIMITS.graceAfterEndMinutes * 60_000);
    const shut = (state: 'locked' | 'closed', reason: AppointmentAccessReason): AppointmentAccessView => ({
        state, reason, opensAt, closesAt, hasInstructions, hasMeetingUrl,
    });

    const status = booking.status as string;
    if (
        status === BookingStatus.CANCELLED
        || status === BookingStatus.COMPLETED
        || status === BookingStatus.NO_SHOW
        || now.getTime() > closesAt.getTime()
    ) {
        return shut('closed', 'ended');
    }
    if (status !== BookingStatus.CONFIRMED) return shut('locked', 'not_confirmed');
    const settled = booking.paymentStatus === 'paid' || booking.requiresPayment === false;
    if (!settled) return shut('locked', 'not_paid');
    if (now.getTime() < opensAt.getTime()) return shut('locked', 'too_early');

    return {
        state: 'open',
        reason: null,
        opensAt,
        closesAt,
        hasInstructions,
        hasMeetingUrl,
        ...(access.instructions ? { instructions: access.instructions } : {}),
        ...(access.meetingUrl ? { meetingUrl: access.meetingUrl } : {}),
    };
}

/**
 * Whether the customer may see the ADDRESS (D-1: from confirmation).
 *
 * The time gate does not apply to the address — a customer has to know where to go before the
 * day in order to get there. Their OWN address is always theirs to see. The vendor's address is
 * shown once the vendor has accepted the booking, and stays shown on its record afterwards.
 */
export function customerMaySeeAddress(
    status: BookingStatus | string,
    kind: AppointmentLocationKind,
): boolean {
    if (kind === 'customer_address') return true;
    if (kind === 'online') return false;
    return status === BookingStatus.CONFIRMED || status === BookingStatus.COMPLETED;
}

/** The location block a CUSTOMER read carries. The address lines only when `customerMaySeeAddress`. */
export interface CustomerLocationView {
    kind: AppointmentLocationKind;
    /** False while the vendor has not accepted yet — the screen says "shown once confirmed". */
    addressVisible: boolean;
    label?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    formattedAddress?: string | null;
    coordinates?: [number, number] | null;
}

export function customerLocationView(
    status: BookingStatus | string,
    location: BookingLocationSnapshot | null | undefined,
): CustomerLocationView | null {
    if (!location) return null;
    const visible = customerMaySeeAddress(status, location.kind);
    if (!visible) return { kind: location.kind, addressVisible: false };
    return {
        kind: location.kind,
        addressVisible: true,
        label: location.label,
        addressLine1: location.addressLine1,
        addressLine2: location.addressLine2,
        city: location.city,
        state: location.state,
        country: location.country,
        formattedAddress: location.formattedAddress,
        coordinates: location.coordinates,
    };
}

// ─── Proposals of a new time (Part B) ───────────────────────────────────────

export interface ProposalLike {
    status: 'open' | 'accepted' | 'declined' | 'withdrawn' | 'lapsed';
    proposedBy: 'vendor' | 'customer';
    slotId?: string;
    startAt: Date;
    endAt: Date;
    previousStartAt: Date;
    previousEndAt: Date;
    proposedAt: Date;
    expiresAt: Date;
    answeredAt: Date | null;
}

/**
 * The status as it is NOW. An `open` proposal past `expiresAt` has lapsed whether or not anything
 * has written that down yet — no job runs, so every reader must ask this rather than read the
 * stored field.
 */
export function effectiveProposalStatus(p: ProposalLike, now: Date = new Date()): ProposalLike['status'] {
    if (p.status === 'open' && now.getTime() >= p.expiresAt.getTime()) return 'lapsed';
    return p.status;
}

export interface ProposalView {
    status: ProposalLike['status'];
    proposedBy: 'vendor' | 'customer';
    startAt: Date;
    endAt: Date;
    previousStartAt: Date;
    previousEndAt: Date;
    proposedAt: Date;
    expiresAt: Date;
    answeredAt: Date | null;
}

export function proposalView(p: ProposalLike | null | undefined, now: Date = new Date()): ProposalView | null {
    if (!p) return null;
    return {
        status: effectiveProposalStatus(p, now),
        proposedBy: p.proposedBy,
        startAt: p.startAt,
        endAt: p.endAt,
        previousStartAt: p.previousStartAt,
        previousEndAt: p.previousEndAt,
        proposedAt: p.proposedAt,
        expiresAt: p.expiresAt,
        answeredAt: p.answeredAt,
    };
}

// ─── The customer's projection ───────────────────────────────────────────────

/** The stored fields a customer read must never carry raw. */
/**
 * `statusHistory` (2026-10-27, ADMIN-BOOKINGS-PLAN § 3) names the vendor's id, an administrator's
 * account id and the reason they gave. It is an administrators' record, never a customer's.
 */
export const CUSTOMER_PRIVATE_BOOKING_FIELDS = ['access', 'location', 'rescheduleProposal', 'statusHistory'] as const;

export interface CustomerAppointmentFields {
    location: CustomerLocationView | null;
    access: AppointmentAccessView | null;
    rescheduleProposal: ProposalView | null;
}

/**
 * Replace a booking's raw `access` / `location` / `rescheduleProposal` with what the customer may
 * see right now.
 *
 * ⛔ **Every customer-facing response that carries a booking goes through this** — the website's
 * reads, the response of the booking itself, the bot's projections. The stored `access` holds
 * the link in clear, so one door that serialises the raw document hands it out early, and that
 * door is enough to defeat the whole gate. `test:appointment-access` scans the doors.
 */
export function customerAppointmentFields(
    booking: AccessGateBooking & {
        location?: BookingLocationSnapshot | null;
        rescheduleProposal?: ProposalLike | null;
    },
    now: Date = new Date(),
): CustomerAppointmentFields {
    return {
        location: customerLocationView(booking.status, booking.location),
        access: computeAppointmentAccess(booking, now),
        rescheduleProposal: proposalView(booking.rescheduleProposal, now),
    };
}

/** `plain` minus the private fields, plus their customer views. For a serialised booking. */
export function toCustomerBookingShape<T extends Record<string, unknown>>(
    plain: T,
    raw: Parameters<typeof customerAppointmentFields>[0],
    now: Date = new Date(),
): Omit<T, (typeof CUSTOMER_PRIVATE_BOOKING_FIELDS)[number]> & CustomerAppointmentFields {
    const { access: _a, location: _l, rescheduleProposal: _p, statusHistory: _h, ...rest } = plain;
    void _a; void _l; void _p; void _h;
    return { ...rest, ...customerAppointmentFields(raw, now) } as Omit<T, (typeof CUSTOMER_PRIVATE_BOOKING_FIELDS)[number]> & CustomerAppointmentFields;
}

/** One line for a calendar event or a message: the formatted address, or the parts joined. */
export function oneLineAddress(location: BookingLocationSnapshot | null | undefined): string | null {
    if (!location || location.kind === 'online') return null;
    if (location.formattedAddress) return location.formattedAddress;
    const parts = [location.addressLine1, location.addressLine2, location.city, location.state, location.country]
        .filter((p): p is string => !!p && p.trim().length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The `location` of the VENDOR'S own calendar event: the address, or the meeting link for an
 * online session. The vendor's calendar is theirs, so the link is not gated there.
 */
export function calendarLocationOf(
    location: BookingLocationSnapshot | null | undefined,
    access: AppointmentAccessSetting | null | undefined,
): string | undefined {
    if (location?.kind === 'online') return access?.meetingUrl ?? undefined;
    return oneLineAddress(location) ?? undefined;
}

function clampReveal(minutes: number | null | undefined): number {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return APPOINTMENT_LIMITS.revealMinutesDefault;
    return Math.min(APPOINTMENT_LIMITS.revealMinutesMax, Math.max(0, Math.round(minutes)));
}
