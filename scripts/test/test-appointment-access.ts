/**
 * test:appointment-access — where an appointment happens, who sees its link and when, and who
 * must agree when it moves.
 *
 * Plan and owner decisions (D-1 … D-10): PRODUCTION-READINESS/APPOINTMENT-LOCATION-AND-ACCESS-PLAN.md.
 *
 * Offline: the rules are pure functions (`booking/domain/appointment.ts`,
 * `booking/domain/reschedule-proposal.ts`), and the places that must CALL them are pinned by
 * source scans — the gate is only as strong as the one door that forgets it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    APPOINTMENT_LIMITS,
    calendarLocationOf,
    computeAppointmentAccess,
    customerLocationView,
    effectiveProposalStatus,
    isAcceptableMeetingUrl,
    mergeAccessSetting,
    mergeAppointmentSettings,
    oneLineAddress,
    toCustomerBookingShape,
    type BookingLocationSnapshot,
    type ProposalLike,
} from '../../src/modules/booking/domain/appointment';
import {
    AppointmentAccessPatchSchema,
    AppointmentLocationSchema,
    BookingAccessPatchSchema,
} from '../../src/modules/booking/domain/appointment.validators';
import {
    answererOf,
    declinedVendorProposal,
    hasLiveProposal,
    openProposalMatch,
    proposalExpiry,
    rescheduleDecision,
} from '../../src/modules/booking/domain/reschedule-proposal';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean): void {
    try {
        if (fn()) {
            passed += 1;
            originalConsole.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            originalConsole.log(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        originalConsole.log(`  ❌ THROW: ${label} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Comments out, so a tombstone explaining a rule never satisfies a scan for the rule itself. */
const code = (rel: string): string =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const START = new Date('2026-11-02T14:00:00Z');
const END = new Date('2026-11-02T15:00:00Z');
const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => new Date(START.getTime() + offsetMs);

const ACCESS: { instructions: string | null; meetingUrl: string | null; revealMinutesBefore: number } = {
    instructions: 'Ring the second bell',
    meetingUrl: 'https://meet.example.com/abc',
    revealMinutesBefore: 30,
};

function booking(over: Partial<{
    status: string; paymentStatus: string; requiresPayment: boolean; startAt: Date; endAt: Date;
    access: typeof ACCESS | null; location: BookingLocationSnapshot | null; rescheduleProposal: ProposalLike | null;
}> = {}) {
    return {
        status: BookingStatus.CONFIRMED as string,
        paymentStatus: 'paid',
        requiresPayment: true,
        startAt: START,
        endAt: END,
        access: ACCESS as typeof ACCESS | null,
        location: null as BookingLocationSnapshot | null,
        rescheduleProposal: null as ProposalLike | null,
        ...over,
    };
}

const SHOP: BookingLocationSnapshot = {
    kind: 'vendor_address', label: 'Main salon', addressLine1: '12 Rue de la Joie', addressLine2: null,
    city: 'Douala', state: 'Littoral', country: 'CM', formattedAddress: '12 Rue de la Joie, Douala',
    coordinates: [9.7, 4.05], sourceAddressId: '66f1a2b3c4d5e6f708192a60',
};
const HOME: BookingLocationSnapshot = { ...SHOP, kind: 'customer_address', label: 'Home' };
const ONLINE: BookingLocationSnapshot = {
    kind: 'online', label: null, addressLine1: null, addressLine2: null, city: null, state: null,
    country: null, formattedAddress: null, coordinates: null, sourceAddressId: null,
};

function main(): void {
    // ── 1. The time gate ────────────────────────────────────────────────────
    section('1. The link opens at start − margin, closes an hour after the end (D-4, D-7, D-10)');

    assert('one millisecond before opensAt → locked, too_early', () => {
        const v = computeAppointmentAccess(booking(), at(-minutes(30) - 1))!;
        return v.state === 'locked' && v.reason === 'too_early';
    });
    assert('exactly at opensAt → open, and the link and instructions are present', () => {
        const v = computeAppointmentAccess(booking(), at(-minutes(30)))!;
        return v.state === 'open' && v.meetingUrl === ACCESS.meetingUrl && v.instructions === ACCESS.instructions;
    });
    assert('during the appointment → open', () =>
        computeAppointmentAccess(booking(), at(minutes(20)))!.state === 'open');
    assert('the grace hour after the end is still open (D-4)', () =>
        computeAppointmentAccess(booking(), new Date(END.getTime() + minutes(60)))!.state === 'open');
    assert('one millisecond past closesAt → closed, ended', () => {
        const v = computeAppointmentAccess(booking(), new Date(END.getTime() + minutes(60) + 1))!;
        return v.state === 'closed' && v.reason === 'ended';
    });
    assert('the vendor\'s margin is honoured — 60 minutes opens an hour before', () => {
        const b = booking({ access: { ...ACCESS, revealMinutesBefore: 60 } });
        return computeAppointmentAccess(b, at(-minutes(60)))!.state === 'open'
            && computeAppointmentAccess(b, at(-minutes(60) - 1))!.state === 'locked';
    });
    assert('a margin of 0 opens exactly at the start', () => {
        const b = booking({ access: { ...ACCESS, revealMinutesBefore: 0 } });
        return computeAppointmentAccess(b, at(-1))!.state === 'locked' && computeAppointmentAccess(b, START)!.state === 'open';
    });
    assert('opensAt / closesAt are reported even while locked, so a screen can count down', () => {
        const v = computeAppointmentAccess(booking(), at(-minutes(120)))!;
        return v.opensAt.getTime() === at(-minutes(30)).getTime()
            && v.closesAt.getTime() === END.getTime() + minutes(APPOINTMENT_LIMITS.graceAfterEndMinutes);
    });
    assert('⛔ while locked the link and instructions are ABSENT — not null, not empty: absent', () => {
        const v = computeAppointmentAccess(booking(), at(-minutes(120)))! as unknown as Record<string, unknown>;
        return !('meetingUrl' in v) && !('instructions' in v) && v.hasMeetingUrl === true && v.hasInstructions === true;
    });
    assert('a reschedule moves the window with it — nothing stored to update', () => {
        const later = new Date(START.getTime() + minutes(24 * 60));
        const b = booking({ startAt: later, endAt: new Date(later.getTime() + minutes(60)) });
        return computeAppointmentAccess(b, at(-minutes(30)))!.state === 'locked';
    });

    section('2. Only a CONFIRMED, PAID appointment opens (D-3)');

    assert('⛔ unpaid — even inside the window — stays locked, reason not_paid', () => {
        const v = computeAppointmentAccess(booking({ paymentStatus: 'unpaid' }), at(0))!;
        return v.state === 'locked' && v.reason === 'not_paid' && !('meetingUrl' in v);
    });
    assert('⛔ an unpaid CASH booking stays locked until the vendor marks it paid', () =>
        computeAppointmentAccess(booking({ paymentStatus: 'unpaid' }), at(0))!.state === 'locked'
        && computeAppointmentAccess(booking({ paymentStatus: 'paid' }), at(0))!.state === 'open');
    assert('a payment in flight (`pending`) or failed does not open it', () =>
        ['pending', 'failed', 'disputed', 'refund_pending', 'refunded'].every((ps) =>
            computeAppointmentAccess(booking({ paymentStatus: ps }), at(0))!.state !== 'open'));
    assert('a booking that needs no payment opens (it can never become "paid")', () =>
        computeAppointmentAccess(booking({ paymentStatus: 'unpaid', requiresPayment: false }), at(0))!.state === 'open');
    assert('awaiting the vendor (pending) → locked, not_confirmed', () => {
        const v = computeAppointmentAccess(booking({ status: BookingStatus.PENDING }), at(0))!;
        return v.state === 'locked' && v.reason === 'not_confirmed';
    });
    assert('cancelled, completed and no-show are closed', () =>
        [BookingStatus.CANCELLED, BookingStatus.COMPLETED, BookingStatus.NO_SHOW].every((st) =>
            computeAppointmentAccess(booking({ status: st }), at(0))!.state === 'closed'));
    assert('no access details at all → no block (null), nothing to gate', () =>
        computeAppointmentAccess(booking({ access: null }), at(0)) === null
        && computeAppointmentAccess(booking({ access: { instructions: null, meetingUrl: null, revealMinutesBefore: 30 } }), at(0)) === null);

    // ── 3. The address ──────────────────────────────────────────────────────
    section('3. The address: from confirmation, no time gate (D-1)');

    assert('the vendor\'s address is hidden while the vendor has not accepted', () => {
        const v = customerLocationView(BookingStatus.PENDING, SHOP)!;
        return v.addressVisible === false && !('addressLine1' in v) && v.kind === 'vendor_address';
    });
    assert('…and shown once confirmed, days before the appointment', () => {
        const v = customerLocationView(BookingStatus.CONFIRMED, SHOP)!;
        return v.addressVisible && v.addressLine1 === SHOP.addressLine1 && v.formattedAddress === SHOP.formattedAddress;
    });
    assert('the customer\'s OWN address is always theirs to see', () =>
        customerLocationView(BookingStatus.PENDING, HOME)!.addressVisible === true);
    assert('online carries no address', () => {
        const v = customerLocationView(BookingStatus.CONFIRMED, ONLINE)!;
        return v.kind === 'online' && v.addressVisible === false;
    });
    assert('a booking from before the feature has no location block', () => customerLocationView(BookingStatus.CONFIRMED, null) === null);
    assert('the one-line address prefers the geocoded line, and falls back to the parts', () =>
        oneLineAddress(SHOP) === SHOP.formattedAddress
        && oneLineAddress({ ...SHOP, formattedAddress: null }) === '12 Rue de la Joie, Douala, Littoral, CM'
        && oneLineAddress(ONLINE) === null);
    assert('the vendor\'s own calendar gets the address, or the link for an online session', () =>
        calendarLocationOf(SHOP, ACCESS) === SHOP.formattedAddress
        && calendarLocationOf(ONLINE, ACCESS) === ACCESS.meetingUrl
        && calendarLocationOf(null, ACCESS) === undefined);

    // ── 4. The customer projection ──────────────────────────────────────────
    section('4. ⛔ The raw fields never reach a customer');

    assert('toCustomerBookingShape replaces raw access / location / proposal with their views', () => {
        const raw = booking({ location: SHOP });
        const plain = { id: 'b1', status: 'confirmed', access: ACCESS, location: SHOP, rescheduleProposal: null, priceSnapshot: 5000 };
        const shaped = toCustomerBookingShape(plain, raw, at(-minutes(120))) as unknown as Record<string, any>;
        return shaped.priceSnapshot === 5000
            && shaped.access.state === 'locked' && !('meetingUrl' in shaped.access)
            && JSON.stringify(shaped).indexOf(ACCESS.meetingUrl!) === -1
            && JSON.stringify(shaped).indexOf(ACCESS.instructions!) === -1
            && shaped.location.addressVisible === true;
    });

    // ── 5. Input rules ──────────────────────────────────────────────────────
    section('5. What a vendor may write');

    assert('an https link is accepted', () => isAcceptableMeetingUrl('https://meet.google.com/abc-defg-hij'));
    assert('⛔ http, javascript:, data:, relative and padded values are refused', () =>
        ['http://meet.example.com', 'javascript:alert(1)', 'data:text/html,hi', '/relative', ' https://x.com', 'HTTPS://', '']
            .every((u) => !isAcceptableMeetingUrl(u)));
    assert('a link over the length cap is refused', () =>
        !isAcceptableMeetingUrl('https://x.com/' + 'a'.repeat(APPOINTMENT_LIMITS.meetingUrlMax)));
    assert('vendor_address needs its id; the other kinds refuse one', () =>
        !AppointmentLocationSchema.safeParse({ kind: 'vendor_address' }).success
        && AppointmentLocationSchema.safeParse({ kind: 'vendor_address', vendorAddressId: '66f1a2b3c4d5e6f708192a60' }).success
        && !AppointmentLocationSchema.safeParse({ kind: 'online', vendorAddressId: '66f1a2b3c4d5e6f708192a60' }).success
        && AppointmentLocationSchema.safeParse({ kind: 'customer_address' }).success);
    assert('an unknown place kind is refused', () => !AppointmentLocationSchema.safeParse({ kind: 'moon' }).success);
    assert('\'\' and null both CLEAR a text field', () => {
        const a = AppointmentAccessPatchSchema.parse({ instructions: '', meetingUrl: '' });
        const b = AppointmentAccessPatchSchema.parse({ instructions: null, meetingUrl: null });
        return a.instructions === null && a.meetingUrl === null && b.instructions === null && b.meetingUrl === null;
    });
    assert('the margin is 0 … 1440 minutes (D-10)', () =>
        AppointmentAccessPatchSchema.safeParse({ revealMinutesBefore: 0 }).success
        && AppointmentAccessPatchSchema.safeParse({ revealMinutesBefore: 1440 }).success
        && !AppointmentAccessPatchSchema.safeParse({ revealMinutesBefore: 1441 }).success
        && !AppointmentAccessPatchSchema.safeParse({ revealMinutesBefore: -1 }).success);
    assert('a per-booking edit must change something; unknown keys are refused', () =>
        !BookingAccessPatchSchema.safeParse({}).success
        && !BookingAccessPatchSchema.safeParse({ meetingUrl: 'https://x.com', extra: 1 }).success);
    assert('a patch KEEPS what it omits and clears what it nulls', () => {
        const merged = mergeAccessSetting(ACCESS, { meetingUrl: null })!;
        return merged.meetingUrl === null && merged.instructions === ACCESS.instructions && merged.revealMinutesBefore === 30;
    });
    assert('⛔ a service edit that does not mention the place keeps the place and the link', () => {
        const kept = mergeAppointmentSettings({ location: { kind: 'online', vendorAddressId: null }, access: ACCESS }, {});
        return kept.location?.kind === 'online' && kept.access?.meetingUrl === ACCESS.meetingUrl;
    });

    // ── 6. Who agrees to a move ─────────────────────────────────────────────
    section('6. Who must agree when an appointment moves (D-8, D-9)');

    assert('a VENDOR\'s move is always a proposal, whatever the mode', () =>
        ['calendar', 'manual', 'capacity'].every((m) => rescheduleDecision('vendor', m) === 'propose'));
    assert('a CUSTOMER\'s move applies on calendar / capacity services…', () =>
        rescheduleDecision('customer', 'calendar') === 'apply' && rescheduleDecision('customer', 'capacity') === 'apply');
    assert('…and is a request on a manual service', () => rescheduleDecision('customer', 'manual') === 'propose');
    assert('the other side answers', () => answererOf('vendor') === 'customer' && answererOf('customer') === 'vendor');
    assert('a proposal lapses at the ORIGINAL start, or at the proposed one if earlier', () => {
        const original = new Date('2026-11-05T10:00:00Z');
        const earlier = new Date('2026-11-04T10:00:00Z');
        const later = new Date('2026-11-06T10:00:00Z');
        return proposalExpiry(original, later).getTime() === original.getTime()
            && proposalExpiry(original, earlier).getTime() === earlier.getTime();
    });
    const proposal: ProposalLike = {
        status: 'open', proposedBy: 'vendor', startAt: END, endAt: new Date(END.getTime() + minutes(60)),
        previousStartAt: START, previousEndAt: END, proposedAt: at(-minutes(600)), expiresAt: START, answeredAt: null,
    };
    assert('an open proposal past expiresAt reads as lapsed — no job needed', () =>
        effectiveProposalStatus(proposal, at(-1)) === 'open' && effectiveProposalStatus(proposal, START) === 'lapsed'
        && hasLiveProposal(proposal, at(-1)) && !hasLiveProposal(proposal, START));
    assert('the occupancy condition carries the date, so a lapsed proposal holds nothing', () => {
        const m = openProposalMatch(START) as Record<string, any>;
        return m['rescheduleProposal.status'] === 'open' && m['rescheduleProposal.expiresAt'].$gt.getTime() === START.getTime();
    });
    assert('only a DECLINED VENDOR proposal waives the cancellation policy', () =>
        declinedVendorProposal({ status: 'declined', proposedBy: 'vendor' })
        && !declinedVendorProposal({ status: 'declined', proposedBy: 'customer' })
        && !declinedVendorProposal({ status: 'accepted', proposedBy: 'vendor' })
        && !declinedVendorProposal({ status: 'open', proposedBy: 'vendor' })
        && !declinedVendorProposal(null));

    // ── 7. The doors that must call the rules ───────────────────────────────
    section('7. ⛔ Every door calls the rules (source)');

    const variantController = code('modules/catalog/controllers/vendor-variant.controller.ts');
    assert('all three serviceConfig writes keep the place and the link (mergeAppointmentSettings ×3)', () =>
        (variantController.match(/mergeAppointmentSettings\(/g) ?? []).length === 3
        && (variantController.match(/appointmentLocationService\.assertVendorAddress\(/g) ?? []).length === 3);

    const vectoriser = code('modules/catalog/domain/services/VectorisationService.ts');
    assert('⛔ the vectoriser never copies serviceConfig whole — the link stays out of the bot\'s search', () =>
        !/variant\.serviceConfig\s*=\s*v\.serviceConfig\s*;/.test(vectoriser)
        && /const \{ access: _private, location, \.\.\.publicConfig \} = v\.serviceConfig;/.test(vectoriser));

    const publicDto = code('modules/catalog/dto/public-product.dto.ts');
    assert('⛔ the public product page publishes the place KIND only — no access, no address id', () =>
        publicDto.includes('locationKind: variant.serviceConfig.location?.kind ?? null')
        && !/serviceConfig\.access/.test(publicDto) && !/vendorAddressId/.test(publicDto));

    assert('⛔ the customer reads go through toCustomerBookingShape', () =>
        code('modules/booking/controllers/customer-booking.controller.ts').includes('toCustomerBookingShape(visible,'));
    assert('⛔ the booking door answers with the shaped booking, never the raw one', () => {
        const route = code('modules/catalog/routes/product-booking.routes.ts');
        return route.includes('booking: toCustomerBookingShape(') && !/booking:\s*result\.booking\s*,/.test(route);
    });
    assert('⛔ the bot\'s booking projection uses the same gate', () =>
        code('modules/bot-surface/dto/bot-projections.ts').includes('...customerAppointmentFields({'));

    const bookingService = code('modules/booking/services/booking.service.ts');
    const groupService = code('modules/booking/services/group-booking.service.ts');
    assert('an open proposal holds its time in all three occupancy queries', () =>
        (bookingService.match(/\.\.\.openProposalMatch\(new Date\(\)\)/g) ?? []).length === 2
        && groupService.includes('...openProposalMatch(new Date())'));
    assert('a live proposal blocks a second move', () =>
        /if \(hasLiveProposal\(booking\.rescheduleProposal\)\) \{\s*throw createAppError\(ERROR_CODES\.BOOKING_PROPOSAL_PENDING/.test(bookingService));
    assert('the cancellation policy is skipped ONLY behind declinedVendorProposal, and the vendor then pays the fees', () =>
        /const vendorDeclined = declinedVendorProposal\(booking\.rescheduleProposal\);\s*if \(!vendorDeclined\) \{/.test(bookingService)
        && bookingService.includes("vendorDeclined ? 'vendor' : undefined"));
    assert('every booking door passes the customer\'s address to bookProduct', () =>
        code('modules/catalog/routes/product-booking.routes.ts').includes('addressId\n')
        || code('modules/catalog/routes/product-booking.routes.ts').includes('metadata,\n    addressId'));
    assert('…the bot tool and the mini-app too', () =>
        code('modules/bot-surface/controllers/bot-booking.controller.ts').includes('input.addressId ?? null')
        // The screen's own choice first, then the address the chat's address step collected (2026-10-27).
        && code('modules/bot-surface/miniapp/surfaces/booking.core.ts').includes('input.addressId ?? session.addressId ?? null'));

    originalConsole.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    originalConsole.error('Suite crashed:', error);
    process.exitCode = 1;
}
